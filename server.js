const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { authenticateUser, registerUser, AuthError } = require('./auth');
const { stmtGetAllUsers } = require('./db');

// Tenta carregar a função de backup caso o arquivo driveBackup.js exista
let uploadDatabaseBackup = null;
try {
  uploadDatabaseBackup = require('./driveBackup').uploadDatabaseBackup;
} catch {
  console.log('[Info] Módulo driveBackup.js não encontrado. Backups para o Google Drive desativados.');
}

const PORT = process.env.PORT || 8080;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const DB_PATH = path.join(__dirname, 'database.db'); // Caminho do banco SQLite

// Map para rastreamento de sessões: username -> { ws, displayName, isBusy, callTarget }
const activeSockets = new Map();

// --- SERVIDOR HTTP (Rotas /ping, /health e Keep-Alive) ---
const server = http.createServer((req, res) => {
  if (req.url === '/ping') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    return res.end('pong');
  }

  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      status: 'OK',
      onlineUsers: activeSockets.size,
      uptime: Math.floor(process.uptime()),
      timestamp: new Date().toISOString()
    }));
  }

  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Servidor WebSocket "Anda Mãe Vamos Mãe" rodando.');
});

// Configurações de Keep-Alive TCP contra timeouts do proxy do Render
server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Self-ping HTTP a cada 10 minutos para impedir suspensão no plano gratuito do Render
if (RENDER_URL) {
  const TEN_MINUTES = 10 * 60 * 1000;
  setInterval(async () => {
    try {
      await fetch(`${RENDER_URL}/ping`);
      console.log('[Keep-Alive] Ping HTTP enviado com sucesso.');
    } catch (err) {
      console.error('[Keep-Alive] Falha ao enviar ping HTTP:', err.message);
    }
  }, TEN_MINUTES);
}

// Rotina de Backup no Google Drive (Executa ao iniciar e a cada 6 horas)
if (typeof uploadDatabaseBackup === 'function') {
  const SIX_HOURS = 6 * 60 * 60 * 1000;
  
  // Executa o primeiro backup 30 segundos após iniciar
  setTimeout(() => uploadDatabaseBackup(DB_PATH), 30000);
  
  // Repete o backup a cada 6 horas
  setInterval(() => uploadDatabaseBackup(DB_PATH), SIX_HOURS);
}

// --- SERVIDOR WEBSOCKET ---
const wss = new WebSocketServer({ server });

// Monitoramento de latência e heartbeat
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) {
      console.log('[WS] Fechando conexão inativa.');
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 45000);

wss.on('close', () => clearInterval(pingInterval));

// --- HELPER FUNCTIONS ---
function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws, message) {
  send(ws, { type: 'auth_error', message });
}

function getUsersData() {
  try {
    return stmtGetAllUsers.all().map(u => ({
      username: u.username,
      displayName: u.displayName,
      avatar: u.avatar,
      role: u.role,
      online: activeSockets.has(u.username)
    }));
  } catch (err) {
    console.error('[DB Error] Falha ao listar usuários:', err.message);
    return [];
  }
}

function broadcastUserList() {
  const payload = { type: 'user_list', users: getUsersData() };
  for (const { ws } of activeSockets.values()) {
    send(ws, payload);
  }
}

function endUserCall(username) {
  const session = activeSockets.get(username);
  if (!session) return;

  const targetUsername = session.callTarget;
  session.isBusy = false;
  session.callTarget = null;

  if (targetUsername) {
    const targetSession = activeSockets.get(targetUsername);
    if (targetSession) {
      targetSession.isBusy = false;
      targetSession.callTarget = null;
      send(targetSession.ws, { type: 'call_ended', from: username });
    }
  }
}

// --- GERENCIAMENTO DE CONEXÕES ---
wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let currentUsername = null;

  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, 'Formato JSON inválido.');
    }

    try {
      switch (data.type) {
        case 'ping': {
          ws.isAlive = true;
          return send(ws, { type: 'pong' });
        }

        case 'pong': {
          ws.isAlive = true;
          break;
        }

        case 'register': {
          if (!data.username || !data.password) {
            return sendError(ws, 'Usuário e senha são obrigatórios.');
          }
          const user = await registerUser(data.username, data.password, data.displayName, data.avatar);
          currentUsername = user.username;

          activeSockets.set(currentUsername, { 
            ws, 
            displayName: user.displayName, 
            isBusy: false, 
            callTarget: null 
          });

          send(ws, { type: 'auth_success', user });
          broadcastUserList();
          break;
        }

        case 'login': {
          if (!data.username || !data.password) {
            return sendError(ws, 'Usuário e senha são obrigatórios.');
          }
          const user = await authenticateUser(data.username, data.password);
          currentUsername = user.username;

          // Se o usuário já estava logado, fecha o socket anterior
          const existingSession = activeSockets.get(currentUsername);
          if (existingSession && existingSession.ws !== ws) {
            endUserCall(currentUsername);
            send(existingSession.ws, { type: 'auth_error', message: 'Sessão iniciada em outro local.' });
            existingSession.ws.close();
          }

          activeSockets.set(currentUsername, { 
            ws, 
            displayName: user.displayName, 
            isBusy: false, 
            callTarget: null 
          });

          send(ws, { type: 'auth_success', user });
          broadcastUserList();
          break;
        }

        case 'get_users': {
          if (!currentUsername) return sendError(ws, 'Não autenticado.');
          send(ws, { type: 'user_list', users: getUsersData() });
          break;
        }

        case 'call_initiate': {
          if (!currentUsername) return sendError(ws, 'Não autenticado.');

          const calleeSession = activeSockets.get(data.callee);
          if (!calleeSession) {
            return send(ws, { type: 'call_error', message: 'Usuário offline ou indisponível.' });
          }

          if (calleeSession.isBusy) {
            return send(ws, { type: 'call_error', message: 'Usuário já está em uma chamada.' });
          }

          const callerSession = activeSockets.get(currentUsername);
          if (callerSession) {
            callerSession.isBusy = true;
            callerSession.callTarget = data.callee;
          }

          send(calleeSession.ws, {
            type: 'call_incoming',
            caller: currentUsername,
            callerDisplayName: callerSession?.displayName || currentUsername,
            offer: data.offer
          });
          break;
        }

        case 'call_answer': {
          if (!currentUsername) return;
          const callerSession = activeSockets.get(data.caller);
          const answererSession = activeSockets.get(currentUsername);

          if (answererSession) {
            answererSession.isBusy = true;
            answererSession.callTarget = data.caller;
          }

          if (callerSession) {
            callerSession.isBusy = true;
            callerSession.callTarget = currentUsername;

            send(callerSession.ws, {
              type: 'call_answered',
              answerer: currentUsername,
              answer: data.answer
            });
          }
          break;
        }

        case 'call_ice_candidate': {
          if (!currentUsername) return;
          const targetSession = activeSockets.get(data.to);
          if (targetSession) {
            send(targetSession.ws, {
              type: 'call_ice_candidate',
              from: currentUsername,
              candidate: data.candidate
            });
          }
          break;
        }

        case 'call_end': {
          if (!currentUsername) return;
          endUserCall(currentUsername);
          break;
        }

        default:
          sendError(ws, 'Comando não reconhecido.');
      }
    } catch (err) {
      if (err instanceof AuthError) {
        sendError(ws, err.message);
      } else {
        console.error(`[Erro de Processamento] Usuário ${currentUsername || 'Anônimo'}:`, err);
        sendError(ws, 'Erro interno do servidor.');
      }
    }
  });

  ws.on('close', () => {
    if (currentUsername) {
      const session = activeSockets.get(currentUsername);
      if (session && session.ws === ws) {
        endUserCall(currentUsername);
        activeSockets.delete(currentUsername);
        broadcastUserList();
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[WebSocket Error] ${currentUsername || 'Sem login'}:`, err.message);
  });
});

// Encerramento Gracioso
const handleShutdown = () => {
  console.log('Encerrando servidor...');
  clearInterval(pingInterval);
  wss.close(() => {
    server.close(() => {
      console.log('Servidor encerrado.');
      process.exit(0);
    });
  });
};

process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);

server.listen(PORT, () => {
  console.log(`🚀 Servidor "Anda Mãe Vamos Mãe" rodando na porta ${PORT}`);
});
