// server.js - Ultra Otimizado para Render (< 30MB RAM)
const { WebSocketServer, WebSocket } = require('ws');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 8080;

// SQLite com otimizações extremas de memória
const db = new Database('zapzap.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -2000'); // Limita cache RAM do SQLite a ~2MB

// Tabela e Índices Otimizados
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        displayName TEXT NOT NULL,
        avatar TEXT,
        role TEXT DEFAULT 'Membro'
    );

    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT,
        receiver TEXT,
        mediaType TEXT,
        content TEXT,
        replyTo TEXT,
        time TEXT,
        timestamp INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender, receiver);
`);

// Statements Preparados em Memória
const stmtRegister = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)');
const stmtGetUser = db.prepare('SELECT username, password, displayName, avatar, role FROM users WHERE username = ?');
const stmtSaveMsg = db.prepare('INSERT INTO messages (id, sender, receiver, mediaType, content, replyTo, time, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
const stmtGetHistory = db.prepare(`
    SELECT * FROM (
        SELECT id, sender, receiver, mediaType, content, replyTo, time, timestamp 
        FROM messages 
        WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
        ORDER BY timestamp DESC LIMIT 50
    ) ORDER BY timestamp ASC
`);

const activeSockets = new Map(); // username -> ws

const wss = new WebSocketServer({ 
    port: PORT,
    maxPayload: 15 * 1024 * 1024 // Limite seguro para imagens/áudios (~15MB)
});

console.log(`[ZapZap Server] Rodando na porta ${PORT}`);

// Notifica mudança de status (Online/Offline) para contatos
function broadcastStatus(username, isOnline) {
    const payload = JSON.stringify({ type: 'status_update', username, online: isOnline });
    activeSockets.forEach((ws, user) => {
        if (user !== username && ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    });
}

wss.on('connection', (ws) => {
    let currentUsername = null;
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (raw) => {
        try {
            const data = JSON.parse(raw);

            // Keep-Alive para evitar timeout de inatividade no Render
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            switch (data.type) {
                case 'register': {
                    const cleanUser = data.username?.trim().toLowerCase();
                    if (!cleanUser || !data.password) return;

                    const userCount = db.prepare('SELECT count(*) as count FROM users').get().count;
                    const role = userCount === 0 ? 'Criador' : (cleanUser === 'admin' ? 'Admin' : 'Membro');

                    try {
                        stmtRegister.run(cleanUser, data.password, data.displayName || cleanUser, data.avatar || '', role);
                        currentUsername = cleanUser;
                        activeSockets.set(cleanUser, ws);

                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            user: { username: cleanUser, displayName: data.displayName || cleanUser, avatar: data.avatar || '', role }
                        }));
                        broadcastStatus(cleanUser, true);
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Usuário já cadastrado!' }));
                    }
                    break;
                }

                case 'login': {
                    const cleanUser = data.username?.trim().toLowerCase();
                    const user = stmtGetUser.get(cleanUser);

                    if (user && user.password === data.password) {
                        currentUsername = cleanUser;
                        activeSockets.set(cleanUser, ws);

                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            user: { username: user.username, displayName: user.displayName, avatar: user.avatar, role: user.role }
                        }));
                        broadcastStatus(cleanUser, true);
                    } else {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Credenciais inválidas!' }));
                    }
                    break;
                }

                case 'find_user': {
                    if (!currentUsername) return;
                    const targetName = data.targetUsername?.trim().toLowerCase();
                    const target = stmtGetUser.get(targetName);

                    if (target) {
                        const history = stmtGetHistory.all(currentUsername, target.username, target.username, currentUsername);
                        ws.send(JSON.stringify({
                            type: 'user_found',
                            user: { username: target.username, displayName: target.displayName, avatar: target.avatar, role: target.role },
                            history
                        }));
                    } else {
                        ws.send(JSON.stringify({ type: 'user_not_found', targetUsername: targetName }));
                    }
                    break;
                }

                case 'typing': {
                    if (!currentUsername || !data.to) return;
                    const targetWs = activeSockets.get(data.to.trim().toLowerCase());
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify({ type: 'typing', from: currentUsername }));
                    }
                    break;
                }

                case 'private_message': {
                    if (!currentUsername) return;
                    const recipient = data.to?.trim().toLowerCase();
                    const timeStr = data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const timestamp = Date.now();
                    const msgId = data.id || 'msg_' + timestamp;

                    stmtSaveMsg.run(
                        msgId,
                        currentUsername,
                        recipient,
                        data.mediaType || 'text',
                        data.content,
                        data.replyTo || null,
                        timeStr,
                        timestamp
                    );

                    const payload = {
                        id: msgId,
                        type: 'chat_message',
                        from: currentUsername,
                        to: recipient,
                        mediaType: data.mediaType || 'text',
                        content: data.content,
                        replyTo: data.replyTo || null,
                        time: timeStr
                    };

                    const targetWs = activeSockets.get(recipient);
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify(payload));
                    }
                    
                    // Retorna confirmação/cópia para o próprio remetente
                    ws.send(JSON.stringify(payload));
                    break;
                }
            }
        } catch (e) {
            console.error('[ZapZap Server Error]', e.message);
        }
    });

    ws.on('close', () => {
        if (currentUsername) {
            activeSockets.delete(currentUsername);
            broadcastStatus(currentUsername, false);
        }
    });
});

// Limpeza de conexões inativas a cada 30s para economizar sockets abertos
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(heartbeat));
