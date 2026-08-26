const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { authenticateUser, registerUser, AuthError } = require('./auth');
const { stmtGetAllUsers } = require('./db');

let uploadDatabaseBackup = null;
try {
  uploadDatabaseBackup = require('./driveBackup').uploadDatabaseBackup;
} catch {
  console.log('[Info] driveBackup.js não encontrado.');
}

const PORT = process.env.PORT || 8080;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const DB_PATH = path.join(__dirname, 'database.db');

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
  res.end('Servidor ZapZap WebRTC / Chat Ativo');
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

if (RENDER_URL) {
  setInterval(async () => {
    try { await fetch(`${RENDER_URL}/ping`); } catch (err) {}
  }, 10 * 60 * 1000);
}

if (typeof uploadDatabaseBackup === 'function') {
  setInterval(() => uploadDatabaseBackup(DB_PATH), 6 * 60 * 60 * 1000);
}

const wss = new WebSocketServer({ server });

const pingInterval = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, 45000);

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

wss.on('connection', (ws) => {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });

  let currentUsername = null;

  ws.on('message', async (raw) => {
    let data;
    try {
      data = JSON.parse(raw.toString());
    } catch {
      return sendError(ws, 'JSON Inválido');
    }

    try {
      switch (data.type) {
        case 'ping':
          ws.isAlive = true;
          return send(ws, { type: 'pong' });

        case 'login': {
          const user = await authenticateUser(data.username, data.password);
          currentUsername = user.username;
          activeSockets.set(currentUsername, { ws, displayName: user.displayName, isBusy: false, callTarget: null });
          send(ws, { type: 'auth_success', user });
          broadcastUserList();
          break;
        }

        case 'register': {
          const user = await registerUser(data.username, data.password, data.displayName, data.avatar);
          currentUsername = user.username;
          activeSockets.set(currentUsername, { ws, displayName: user.displayName, isBusy: false, callTarget: null });
          send(ws, { type: 'auth_success', user });
          broadcastUserList();
          break;
        }

        // CHAT DE MENSAGENS E2E SEGURO
        case 'chat_message': {
          if (!currentUsername) return;
          const targetSession = activeSockets.get(data.to);
          const payload = {
            type: 'chat_message',
            from: currentUsername,
            text: data.text,
            timestamp: Date.now()
          };

          if (targetSession) {
            send(targetSession.ws, payload);
          } else {
            // Notificação de mensagem offline
            console.log(`[Offline Message] Usuário ${data.to} está offline.`);
          }
          break;
        }

        case 'call_initiate': {
          if (!currentUsername) return;
          const calleeSession = activeSockets.get(data.callee);
          const callerSession = activeSockets.get(currentUsername);

          if (!calleeSession) {
            return send(ws, { type: 'call_offline', callee: data.callee });
          }

          if (calleeSession.isBusy) {
            return send(ws, { type: 'call_error', message: 'Usuário ocupado.' });
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
      sendError(ws, err.message || 'Erro no servidor.');
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

server.listen(PORT, () => console.log(`🚀 Servidor Ativo na porta ${PORT}`));
