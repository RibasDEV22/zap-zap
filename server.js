// server.js - Produção Otimizada (< 35MB RAM)
const { WebSocketServer, WebSocket } = require('ws');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 8080;

// SQLite nativo de alta performance
const db = new Database('zapzap.db');
db.pragma('journal_mode = WAL');

// Tabelas e Índices para busca rápida
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        displayName TEXT NOT NULL,
        avatar TEXT,
        role TEXT DEFAULT 'Membro'
    );
    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT,
        receiver TEXT,
        mediaType TEXT,
        content TEXT,
        time TEXT,
        timestamp INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_chat_history ON messages(sender, receiver);
`);

const stmtRegister = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?)');
const stmtGetUser = db.prepare('SELECT username, password, displayName, avatar, role FROM users WHERE username = ?');
const stmtSaveMsg = db.prepare('INSERT INTO messages (sender, receiver, mediaType, content, time, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
const stmtGetHistory = db.prepare(`
    SELECT * FROM (
        SELECT sender, receiver, mediaType, content, time, timestamp 
        FROM messages 
        WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
        ORDER BY id DESC LIMIT 50
    ) ORDER BY id ASC
`);

const activeSockets = new Map();

const wss = new WebSocketServer({ 
    port: PORT,
    maxPayload: 10 * 1024 * 1024 // Limite de 10MB por pacote
});

console.log(`[ZapZap Server] Rodando na porta ${PORT}`);

wss.on('connection', (ws) => {
    let currentUsername = null;
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            // MANTÉM A CONEXÃO VIVA NO RENDER
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            switch (data.type) {
                case 'register': {
                    const cleanUser = data.username.trim().toLowerCase();
                    if (!cleanUser || !data.password) return;

                    const count = db.prepare('SELECT count(*) as count FROM users').get().count;
                    const role = count === 0 ? 'Criador' : (cleanUser === 'admin' ? 'Admin' : 'Membro');

                    try {
                        stmtRegister.run(cleanUser, data.password, data.displayName || cleanUser, data.avatar || '', role);
                        currentUsername = cleanUser;
                        activeSockets.set(cleanUser, ws);

                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            user: { username: cleanUser, displayName: data.displayName || cleanUser, avatar: data.avatar || '', role }
                        }));
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Username já cadastrado!' }));
                    }
                    break;
                }

                case 'login': {
                    const cleanUser = data.username.trim().toLowerCase();
                    const user = stmtGetUser.get(cleanUser);

                    if (user && user.password === data.password) {
                        currentUsername = cleanUser;
                        activeSockets.set(cleanUser, ws);

                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            user: { username: user.username, displayName: user.displayName, avatar: user.avatar, role: user.role }
                        }));
                    } else {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Credenciais inválidas!' }));
                    }
                    break;
                }

                case 'find_user': {
                    const target = stmtGetUser.get(data.targetUsername.trim().toLowerCase());
                    if (target) {
                        const history = stmtGetHistory.all(currentUsername, target.username, target.username, currentUsername);
                        ws.send(JSON.stringify({
                            type: 'user_found',
                            user: { username: target.username, displayName: target.displayName, avatar: target.avatar, role: target.role },
                            history
                        }));
                    } else {
                        ws.send(JSON.stringify({ type: 'user_not_found', targetUsername: data.targetUsername }));
                    }
                    break;
                }

                case 'private_message': {
                    if (!currentUsername) return;
                    const recipient = data.to.trim().toLowerCase();
                    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const timestamp = Date.now();

                    stmtSaveMsg.run(currentUsername, recipient, data.mediaType || 'text', data.content, timeStr, timestamp);

                    const payload = {
                        type: 'chat_message',
                        from: currentUsername,
                        to: recipient,
                        mediaType: data.mediaType || 'text',
                        content: data.content,
                        time: timeStr
                    };

                    const targetWs = activeSockets.get(recipient);
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify(payload));
                    }
                    ws.send(JSON.stringify(payload));
                    break;
                }
            }
        } catch (e) {
            console.error('[ZapZap Error]', e);
        }
    });

    ws.on('close', () => {
        if (currentUsername) activeSockets.delete(currentUsername);
    });
});

// Checagem de Conexões Mortas a cada 30 segundos
const interval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(interval));
