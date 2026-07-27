const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const { authenticateUser, registerUser } = require('./auth');
const { stmtSaveMsg, stmtGetHistoryPrivate, db } = require('./db');

const PORT = process.env.PORT || 8080;
const wss = new WebSocketServer({ port: PORT });
const activeSockets = new Map();

// Keep-Alive Ping/Pong (Evita desconexão no Render após 55s)
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(interval));

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    let currentUsername = null;

    ws.on('message', async (raw) => {
        try {
            const data = JSON.parse(raw.toString());

            switch (data.type) {
                case 'register': {
                    const user = await registerUser(data.username, data.password, data.displayName, data.avatar);
                    currentUsername = user.username;
                    activeSockets.set(currentUsername, ws);
                    
                    // Responde sucesso do registro/login para liberar a tela no cliente
                    ws.send(JSON.stringify({ type: 'auth_success', user }));
                    broadcastUserList();
                    break;
                }

                case 'login': {
                    const user = await authenticateUser(data.username, data.password);
                    if (user) {
                        currentUsername = user.username;
                        activeSockets.set(currentUsername, ws);
                        ws.send(JSON.stringify({ type: 'auth_success', user }));
                        broadcastUserList();
                    } else {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Usuário ou senha incorretos.' }));
                    }
                    break;
                }

                case 'get_users': {
                    if (!currentUsername) return;
                    sendUserList(ws);
                    break;
                }

                case 'get_history': {
                    if (!currentUsername || !data.with) return;
                    const history = stmtGetHistoryPrivate.all(currentUsername, data.with, data.with, currentUsername);
                    ws.send(JSON.stringify({
                        type: 'chat_history',
                        with: data.with,
                        messages: history
                    }));
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
                        content: data.content, time: data.time,
                        replyTo: data.replyTo || null
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
            ws.send(JSON.stringify({ type: 'auth_error', message: err.message || 'Erro no processamento.' }));
        }
    });

    ws.on('close', () => {
        if (currentUsername) {
            activeSockets.delete(currentUsername);
            broadcastUserList();
        }
    });
});

function getUsersData() {
    const users = db.prepare('SELECT username, displayName, avatar, role FROM users').all();
    return users.map(u => ({
        ...u,
        online: activeSockets.has(u.username)
    }));
}

function sendUserList(ws) {
    if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'user_list',
            users: getUsersData()
        }));
    }
}

function broadcastUserList() {
    const userListPayload = JSON.stringify({
        type: 'user_list',
        users: getUsersData()
    });
    
    for (const [_, socket] of activeSockets.entries()) {
        if (socket.readyState === WebSocket.OPEN) {
            socket.send(userListPayload);
        }
    }
}

console.log(`Servidor iniciado na porta ${PORT}`);
