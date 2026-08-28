const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { authenticateUser, registerUser } = require('./auth');
const { stmtGetAllUsers, stmtInsertMessage, stmtGetChatHistory, dbPath } = require('./db');

let uploadDatabaseBackup = null;
try {
  uploadDatabaseBackup = require('./driveBackup').uploadDatabaseBackup;
} catch {
  console.log('[Info] driveBackup.js não configurado.');
}

const PORT = process.env.PORT || 8080;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;

// Mapeamento de usuários ativos: username => { ws, displayName, isBusy, callTarget }
const activeSockets = new Map();

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
      uptime: Math.floor(process.uptime())
    }));
  }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Servidor ZapZap - Sinalização WebRTC e Chat de Voz/Texto');
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

// Auto-ping para manter o Render acordado
if (RENDER_URL) {
  setInterval(async () => {
    try { await fetch(`${RENDER_URL}/ping`); } catch (err) {}
  }, 10 * 60 * 1000);
}

// Backup no Google Drive a cada 6 horas se disponível
if (typeof uploadDatabaseBackup === 'function') {
  setInterval(() => uploadDatabaseBackup(dbPath), 6 * 60 * 60 * 1000);
}

const wss = new WebSocketServer({ server });

// Verificação de pulso do WebSocket (Ping/Pong)
const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

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
    return [];
  }
}

function broadcastUserList() {
  const users = getUsersData();
  const payloadUsers = { type: 'users_list', users };
  const payloadContacts = { type: 'contacts_list', users };

  for (const { ws } of activeSockets.values()) {
    send(ws, payloadUsers);
    send(ws, payloadContacts);
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

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let currentUsername = null;

  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, 'Mensagem com formato JSON inválido.');
    }

    try {
      switch (data.type) {
        case 'ping':
          ws.isAlive = true;
          return send(ws, { type: 'pong' });

        case 'login': {
          const user = await authenticateUser(data.username, data.password);
          
          // Encerra sessão antiga se o usuário já estiver conectado em outro dispositivo
          if (activeSockets.has(user.username)) {
            const oldSocket = activeSockets.get(user.username).ws;
            send(oldSocket, { type: 'auth_error', message: 'Nova conexão realizada em outro dispositivo.' });
            oldSocket.close();
          }

          currentUsername = user.username;
          activeSockets.set(currentUsername, { ws, displayName: user.displayName, isBusy: false, callTarget: null });

          send(ws, { type: 'auth_success', user, credentials: { username: data.username, password: data.password } });
          broadcastUserList();
          break;
        }

        case 'register': {
          const user = await registerUser(data.username, data.password, data.displayName, data.avatar);
          
          currentUsername = user.username;
          activeSockets.set(currentUsername, { ws, displayName: user.displayName, isBusy: false, callTarget: null });

          send(ws, { type: 'auth_success', user, credentials: { username: data.username, password: data.password } });
          broadcastUserList();
          break;
        }

        case 'get_contacts':
        case 'get_users': {
          send(ws, { type: 'contacts_list', users: getUsersData() });
          break;
        }

        // --- SISTEMA DE MENSAGENS E HISTÓRICO ---
        case 'chat_message': {
          if (!currentUsername || !data.to || !data.text) return;
          
          const timestamp = Date.now();
          stmtInsertMessage.run(currentUsername, data.to, data.text.trim(), timestamp);

          const payload = {
            type: 'chat_message',
            from: currentUsername,
            to: data.to,
            text: data.text.trim(),
            timestamp
          };

          const targetSession = activeSockets.get(data.to);
          if (targetSession) {
            send(targetSession.ws, payload);
          }
          break;
        }

        case 'get_chat_history': {
          if (!currentUsername || !data.withUser) return;
          
          const history = stmtGetChatHistory.all(currentUsername, data.withUser, data.withUser, currentUsername);
          send(ws, { type: 'chat_history', withUser: data.withUser, messages: history });
          break;
        }

        // --- PROTOCOLO DE SINALIZAÇÃO WEBRTC (LIGAÇÕES DE VOZ) ---
        case 'call_initiate': {
          if (!currentUsername) return;
          const calleeSession = activeSockets.get(data.callee);
          const callerSession = activeSockets.get(currentUsername);

          if (!calleeSession) {
            return send(ws, { type: 'call_offline', callee: data.callee });
          }

          if (calleeSession.isBusy) {
            return send(ws, { type: 'call_error', message: 'O usuário está ocupado em outra chamada.' });
          }

          callerSession.isBusy = true;
          callerSession.callTarget = data.callee;

          send(calleeSession.ws, {
            type: 'call_incoming',
            caller: currentUsername,
            callerDisplayName: callerSession.displayName,
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
            send(callerSession.ws, { type: 'call_answered', answerer: currentUsername, answer: data.answer });
          }
          break;
        }

        case 'call_reject': {
          if (!currentUsername) return;
          const callerSession = activeSockets.get(data.caller);
          if (callerSession) {
            callerSession.isBusy = false;
            callerSession.callTarget = null;
            send(callerSession.ws, { type: 'call_rejected', from: currentUsername });
          }
          break;
        }

        case 'call_ice_candidate': {
          if (!currentUsername) return;
          const targetSession = activeSockets.get(data.to);
          if (targetSession) {
            send(targetSession.ws, { type: 'call_ice_candidate', from: currentUsername, candidate: data.candidate });
          }
          break;
        }

        case 'call_end': {
          if (!currentUsername) return;
          endUserCall(currentUsername);
          break;
        }
      }
    } catch (err) {
      sendError(ws, err.message || 'Erro interno no servidor.');
    }
  });

  ws.on('close', () => {
    if (currentUsername) {
      endUserCall(currentUsername);
      activeSockets.delete(currentUsername);
      broadcastUserList();
    }
  });
});

server.listen(PORT, () => console.log(`🚀 Servidor ZapZap ativo e escutando na porta ${PORT}`));
