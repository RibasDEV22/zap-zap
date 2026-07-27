const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const { authenticateUser, registerUser } = require('./auth');
const { stmtSaveMsg, stmtGetHistoryPrivate, stmtGetUser } = require('./db');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });
const activeSockets = new Map();

wss.on('connection', (ws) => {
    let currentUsername = null;

    ws.on('message', async (raw) => {
        try {
            const data = JSON.parse(raw.toString());

            switch (data.type) {
                case 'register': {
                    const user = await registerUser(data.username, data.password, data.displayName, data.avatar);
                    currentUsername = user.username;
                    activeSockets.set(currentUsername, ws);
                    ws.send(JSON.stringify({ type: 'auth_success', user }));
                    break;
                }

                case 'login': {
                    const user = await authenticateUser(data.username, data.password);
                    if (user) {
                        currentUsername = user.username;
                        activeSockets.set(currentUsername, ws);
                        ws.send(JSON.stringify({ type: 'auth_success', user }));
                    } else {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Credenciais inválidas' }));
                    }
                    break;
                }

                case 'private_message': {
                    if (!currentUsername) return;
                    const msgId = crypto.randomUUID();
                    const timestamp = Date.now();

                    stmtSaveMsg.run(
                        msgId, currentUsername, data.to, null,
                        data.mediaType || 'text', data.content,
                        data.replyTo || null, data.time, timestamp
                    );

                    const payload = {
                        id: msgId, type: 'chat_message',
                        from: currentUsername, to: data.to,
                        mediaType: data.mediaType || 'text',
                        content: data.content, time: data.time
                    };

                    const targetWs = activeSockets.get(data.to);
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify(payload));
                    }
                    ws.send(JSON.stringify(payload));
                    break;
                }
            }
        } catch (err) {
            ws.send(JSON.stringify({ type: 'error', message: err.message }));
        }
    });

    ws.on('close', () => {
        if (currentUsername) activeSockets.delete(currentUsername);
    });
});

console.log(`Servidor iniciado na porta ${PORT}`);
