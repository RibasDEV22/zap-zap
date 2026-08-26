const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const crypto = require('crypto');
const { authenticateUser, registerUser, AuthError } = require('./auth');
const { stmtGetAllUsers } = require('./db');

const PORT = process.env.PORT || 8080;

// Cria um servidor HTTP para o Render gerenciar a porta corretamente
const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('Servidor WebSocket Ok\n');
});

const wss = new WebSocketServer({ server });

// username -> ws
const activeSockets = new Map();

// Keep-alive (Render derruba conexões ociosas)
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
        username: u.username,
        displayName: u.displayName,
        avatar: u.avatar,
        role: u.role,
        online: activeSockets.has(u.username)
    }));
}

function broadcastUserList() {
    const payload = { type: 'user_list', users: getUsersData() };
    for (const socket of activeSockets.values()) {
        send(socket, payload);
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
            return sendError(ws, 'Mensagem inválida recebida pelo servidor.');
        }

        try {
            switch (data.type) {
                case 'register': {
                    const user = await registerUser(data.username, data.password, data.displayName, data.avatar);
                    currentUsername = user.username;
                    activeSockets.set(currentUsername, ws);

                    send(ws, { type: 'auth_success', user });
                    broadcastUserList();
                    break;
                }

                case 'login': {
                    const user = await authenticateUser(data.username, data.password);
                    currentUsername = user.username;

                    const previousSocket = activeSockets.get(currentUsername);
                    if (previousSocket && previousSocket !== ws) {
                        send(previousSocket, { type: 'auth_error', message: 'Você entrou em outro dispositivo.' });
                        previousSocket.close();
                    }

                    activeSockets.set(currentUsername, ws);
                    send(ws, { type: 'auth_success', user });
                    broadcastUserList();
                    break;
                }

                case 'get_users': {
                    if (!currentUsername) return;
                    send(ws, { type: 'user_list', users: getUsersData() });
                    break;
                }

                case 'call_initiate': {
                    if (!currentUsername) return sendError(ws, 'Você precisa estar logado.');
                    const calleeWs = activeSockets.get(data.callee);
                    if (!calleeWs) {
                        return send(ws, { type: 'call_error', message: 'Usuário offline.' });
                    }

                    const caller = getUsersData().find(u => u.username === currentUsername);
                    send(calleeWs, {
                        type: 'call_incoming',
                        caller: currentUsername,
                        callerDisplayName: caller?.displayName || currentUsername,
                        offer: data.offer
                    });
                    break;
                }

                case 'call_answer': {
                    if (!currentUsername) return;
                    const callerWs = activeSockets.get(data.caller);
                    if (callerWs) {
                        send(callerWs, {
                            type: 'call_answered',
                            answerer: currentUsername,
                            answer: data.answer
                        });
                    }
                    break;
                }

                case 'call_ice_candidate': {
                    if (!currentUsername) return;
                    const targetWs = activeSockets.get(data.to);
                    if (targetWs) {
                        send(targetWs, {
                            type: 'call_ice_candidate',
                            from: currentUsername,
                            candidate: data.candidate
                        });
                    }
                    break;
                }

                case 'call_end': {
                    if (!currentUsername) return;
                    const targetWs = activeSockets.get(data.to);
                    if (targetWs) {
                        send(targetWs, {
                            type: 'call_ended',
                            from: currentUsername
                        });
                    }
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

server.listen(PORT, () => {
    console.log(`🎉 Servidor "Anda Mãe Vamos Mãe" rodando na porta ${PORT}`);
});
