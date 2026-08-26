const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { authenticateUser, registerUser, AuthError } = require('./auth');
const { stmtGetAllUsers } = require('./db');

const PORT = process.env.PORT || 8080;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

// Map para rastrear conexões ativas: username -> { ws, displayName }
const activeSockets = new Map();

// --- SERVIDOR HTTP (Rotas /ping, /health e Render Keep-Alive) ---
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
  res.end('Servidor WebSocket "Anda Mãe Vamos Mãe" em execução.');
});

// Auto-ping interno para evitar que o Render entre em modo de suspensão
if (RENDER_URL) {
  const TEN_MINUTES = 10 * 60 * 1000;
  setInterval(async () => {
    try {
      await fetch(`${RENDER_URL}/ping`);
      console.log('[Keep-Alive] Ping enviado ao Render com sucesso.');
    } catch (err) {
      console.error('[Keep-Alive] Falha ao enviar ping:', err.message);
    }
  }, TEN_MINUTES);
}

// --- SERVIDOR WEBSOCKET ---
const wss = new WebSocketServer({ server });

// Keep-alive WebSocket (detecta desconexões repentinas)
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

// --- FUNÇÕES AUXILIARES ---
function send(ws, payload) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

function sendError(ws, message) {
  send(ws, { type: 'auth_error', message });
}

function getUsersData() {
  return stmtGetAllUsers.all().map(u => ({
    username: u.username,
    displayName: u.displayName,
    avatar: u.avatar,
    role: u.role,
    online: activeSockets.has(u.username)
  }));
}

function broadcastUserList() {
  const payload = { type: 'user_list', users: getUsersData() };
  for (const { ws } of activeSockets.values()) {
    send(ws, payload);
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
        case 'register': {
          const user = await registerUser(data.username, data.password, data.displayName, data.avatar);
          currentUsername = user.username;

          activeSockets.set(currentUsername, { ws, displayName: user.displayName });

          send(ws, { type: 'auth_success', user });
          broadcastUserList();
          break;
        }

        case 'login': {
          const user = await authenticateUser(data.username, data.password);
          currentUsername = user.username;

          // Se o usuário já estiver logado em outra aba/dispositivo, desconecta o antigo
          const existingSession = activeSockets.get(currentUsername);
          if (existingSession && existingSession.ws !== ws) {
            send(existingSession.ws, { type: 'auth_error', message: 'Você entrou em outro dispositivo.' });
            existingSession.ws.close();
          }

          activeSockets.set(currentUsername, { ws, displayName: user.displayName });

          send(ws, { type: 'auth_success', user });
          broadcastUserList();
          break;
        }

        case 'get_users': {
          if (!currentUsername) return sendError(ws, 'Sessão não autenticada.');
          send(ws, { type: 'user_list', users: getUsersData() });
          break;
        }

        case 'call_initiate': {
          if (!currentUsername) return sendError(ws, 'Você precisa estar logado.');

          const calleeSession = activeSockets.get(data.callee);
          if (!calleeSession) {
            return send(ws, { type: 'call_error', message: 'Usuário indisponível ou offline.' });
          }

          const callerSession = activeSockets.get(currentUsername);

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
          if (callerSession) {
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
          const targetSession = activeSockets.get(data.to);
          if (targetSession) {
            send(targetSession.ws, {
              type: 'call_ended',
              from: currentUsername
            });
          }
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
        sendError(ws, 'Erro interno no servidor.');
      }
    }
  });

  ws.on('close', () => {
    if (currentUsername) {
      const session = activeSockets.get(currentUsername);
      if (session && session.ws === ws) {
        activeSockets.delete(currentUsername);
        broadcastUserList();
      }
    }
  });

  ws.on('error', (err) => {
    console.error(`[WebSocket Error] ${currentUsername || 'Sem login'}:`, err.message);
  });
});

// --- ENCERRAMENTO GRACIOSO (Graceful Shutdown) ---
const handleShutdown = () => {
  console.log('Encerrando conexões...');
  clearInterval(pingInterval);
  wss.close(() => {
    server.close(() => {
      console.log('Servidor finalizado com sucesso.');
      process.exit(0);
    });
  });
};

process.on('SIGTERM', handleShutdown);
process.on('SIGINT', handleShutdown);

// --- INICIALIZAÇÃO ---
server.listen(PORT, () => {
  console.log(`🚀 Servidor "Anda Mãe Vamos Mãe" rodando na porta ${PORT}`);
});
