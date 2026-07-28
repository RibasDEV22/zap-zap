const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const { authenticateUser, registerUser, AuthError } = require('./auth');
const { stmtSaveMsg, stmtGetHistory, stmtGetAllUsers } = require('./db');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });

// username -> ws
const activeSockets = new Map();

const HISTORY_LIMIT = 100;       // últimas 100 mensagens do grupo
const MAX_MESSAGE_LENGTH = 2000; // evita mensagem gigante travando todo mundo
const MSG_RATE_LIMIT = 5;        // mensagens
const MSG_RATE_WINDOW_MS = 10_000; // por 10s

// --- Keep-alive (Render derruba conexões ociosas) ---
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

function send(ws, payload) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function sendError(ws, message) {
    send(ws, { type: 'auth_error', message });
}

function getUsersData() {
    return stmtGetAllUsers.all().map(u => ({
        ...u,
        online: activeSockets.has(u.username)
    }));
}

function broadcastUserList() {
    const payload = { type: 'user_list', users: getUsersData() };
    for (const socket of activeSockets.values()) {
        send(socket, payload);
    }
}

function broadcastToGroup(payload) {
    for (const socket of activeSockets.values()) {
        send(socket, payload);
    }
}

function getHistory(limit = HISTORY_LIMIT) {
    // stmtGetHistory traz mais recentes primeiro (DESC) — inverte pra ordem cronológica
    return stmtGetHistory.all(limit).reverse();
}

function checkRateLimit(ws) {
    const now = Date.now();
    if (!ws.msgTimestamps) ws.msgTimestamps = [];
    ws.msgTimestamps = ws.msgTimestamps.filter(t => now - t < MSG_RATE_WINDOW_MS);

    if (ws.msgTimestamps.length >= MSG_RATE_LIMIT) return false;

    ws.msgTimestamps.push(now);
    return true;
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
            return sendError(ws, 'Mensagem inválida recebida pelo servidor.');
        }

        try {
            switch (data.type) {
                case 'register': {
                    const user = await registerUser(data.username, data.password, data.displayName, data.avatar);
                    currentUsername = user.username;
                    activeSockets.set(currentUsername, ws);

                    send(ws, { type: 'auth_success', user });
                    send(ws, { type: 'chat_history', messages: getHistory() });
                    broadcastUserList();
                    break;
                }

                case 'login': {
                    const user = await authenticateUser(data.username, data.password);
                    currentUsername = user.username;

                    // Se o usuário já estava logado em outro lugar, desconecta a sessão antiga
                    const previousSocket = activeSockets.get(currentUsername);
                    if (previousSocket && previousSocket !== ws) {
                        send(previousSocket, { type: 'auth_error', message: 'Você entrou em outro dispositivo.' });
                        previousSocket.close();
                    }

                    activeSockets.set(currentUsername, ws);
                    send(ws, { type: 'auth_success', user });
                    send(ws, { type: 'chat_history', messages: getHistory() });
                    broadcastUserList();
                    break;
                }

                case 'get_users': {
                    if (!currentUsername) return;
                    send(ws, { type: 'user_list', users: getUsersData() });
                    break;
                }

                case 'get_history': {
                    if (!currentUsername) return;
                    send(ws, { type: 'chat_history', messages: getHistory() });
                    break;
                }

                case 'group_message': {
                    if (!currentUsername) return sendError(ws, 'Você precisa estar logado.');

                    const content = (data.content || '').toString().trim();
                    if (!content) return;
                    if (content.length > MAX_MESSAGE_LENGTH) {
                        return sendError(ws, `Mensagem muito longa (máx. ${MAX_MESSAGE_LENGTH} caracteres).`);
                    }
                    if (!checkRateLimit(ws)) {
                        return sendError(ws, 'Você está enviando mensagens rápido demais. Espere um pouco.');
                    }

                    const msgId = crypto.randomUUID();
                    const timestamp = Date.now();
                    const timeStr = data.time || new Date(timestamp).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

                    stmtSaveMsg.run(
                        msgId, currentUsername, data.mediaType || 'text',
                        content, data.replyTo || null, timeStr, timestamp
                    );

                    broadcastToGroup({
                        id: msgId,
                        type: 'group_message',
                        from: currentUsername,
                        mediaType: data.mediaType || 'text',
                        content,
                        time: timeStr,
                        replyTo: data.replyTo || null
                    });
                    break;
                }

                default:
                    sendError(ws, 'Tipo de mensagem desconhecido.');
            }
        } catch (err) {
            if (err instanceof AuthError) {
                sendError(ws, err.message);
            } else {
                console.error('Erro inesperado:', err);
                sendError(ws, 'Erro interno no servidor.');
            }
        }
    });

    ws.on('close', () => {
        if (currentUsername && activeSockets.get(currentUsername) === ws) {
            activeSockets.delete(currentUsername);
            broadcastUserList();
        }
    });

    ws.on('error', (err) => {
        console.error('Erro no socket:', err.message);
    });
});

console.log(`Servidor "Anda Mãe Vamos Mãe" rodando na porta ${PORT}`);
