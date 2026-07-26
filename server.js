// server.js - Produção Otimizada para Render (< 35MB RAM)
const { WebSocketServer, WebSocket } = require('ws');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const PORT = process.env.PORT || 8080;
const MAX_MESSAGE_SIZE_BYTES = 10 * 1024 * 1024; // Limite de 10MB para payloads no WS

// --- BANCO DE DADOS (SQLite Otimizado para Memória) ---
const db = new Database('zapzap.db');
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -2000'); // Limita cache SQLite a ~2MB RAM
db.pragma('foreign_keys = ON');

// Criação de Tabelas, Índices Avançados e Estrutura Pronta para Grupos
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        displayName TEXT NOT NULL,
        avatar TEXT,
        role TEXT DEFAULT 'Membro',
        createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        ownerUsername TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        FOREIGN KEY (ownerUsername) REFERENCES users(username)
    );

    CREATE TABLE IF NOT EXISTS group_members (
        groupId TEXT NOT NULL,
        username TEXT NOT NULL,
        joinedAt INTEGER NOT NULL,
        PRIMARY KEY (groupId, username),
        FOREIGN KEY (groupId) REFERENCES groups(id) ON DELETE CASCADE,
        FOREIGN KEY (username) REFERENCES users(username) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        receiver TEXT, -- Se NULL, é uma mensagem de grupo
        groupId TEXT,  -- Se NULL, é uma mensagem privada
        mediaType TEXT NOT NULL,
        content TEXT NOT NULL,
        replyTo TEXT,
        time TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        FOREIGN KEY (sender) REFERENCES users(username)
    );

    -- Índices compostos otimizados para busca instantânea de histórico
    CREATE INDEX IF NOT EXISTS idx_private_chat ON messages(sender, receiver, timestamp);
    CREATE INDEX IF NOT EXISTS idx_group_chat ON messages(groupId, timestamp);
`);

// --- STATEMENTS PREPARADOS ---
const stmtRegister = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)');
const stmtGetUser = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtSaveMsg = db.prepare('INSERT INTO messages (id, sender, receiver, groupId, mediaType, content, replyTo, time, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

const stmtGetHistoryPrivate = db.prepare(`
    SELECT * FROM (
        SELECT id, sender, receiver, groupId, mediaType, content, replyTo, time, timestamp 
        FROM messages 
        WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
        ORDER BY timestamp DESC LIMIT 50
    ) ORDER BY timestamp ASC
`);

// Transação atômica para registro e criação do primeiro usuário
const registerTransaction = db.transaction((cleanUser, hashedPassword, displayName, avatar, role, now) => {
    stmtRegister.run(cleanUser, hashedPassword, displayName, avatar, role, now);
});

// --- CACHE EM MEMÓRIA & GERENCIAMENTO DE CONEXÕES ---
const activeSockets = new Map(); // username -> WebSocket
const userCache = new Map();    // username -> { displayName, avatar, role } (Reduz leituras no DB)
const rateLimits = new Map();   // ip -> { count, lastReset }
const antiFlood = new Map();    // username -> lastMessageTime

// --- ESTRUTURA DE LOGS ORGANIZADOS ---
const log = {
    info: (msg, data = '') => console.log(`[INFO] [${new Date().toISOString()}] ${msg}`, data),
    warn: (msg, data = '') => console.warn(`[WARN] [${new Date().toISOString()}] ${msg}`, data),
    error: (msg, err = '') => console.error(`[ERROR] [${new Date().toISOString()}] ${msg}`, err)
};

// --- SEGURANÇA: RATE LIMIT & ANTI-FLOOD ---
function isRateLimited(ip) {
    const now = Date.now();
    const windowMs = 60 * 1000; // Janela de 1 minuto
    const maxRequests = 120;     // Máximo de requisições por janela

    const record = rateLimits.get(ip) || { count: 0, lastReset: now };

    if (now - record.lastReset > windowMs) {
        record.count = 1;
        record.lastReset = now;
        rateLimits.set(ip, record);
        return false;
    }

    record.count++;
    rateLimits.set(ip, record);
    return record.count > maxRequests;
}

function isFlooding(username) {
    const now = Date.now();
    const lastMsgTime = antiFlood.get(username) || 0;
    if (now - lastMsgTime < 250) { // Trava mensagens enviadas com menos de 250ms de intervalo
        return true;
    }
    antiFlood.set(username, now);
    return false;
}

// --- VALIDAÇÕES DE ENTRADA ---
function sanitizeText(str) {
    if (typeof str !== 'string') return '';
    return str.trim();
}

function broadcastStatus(username, isOnline) {
    const payload = JSON.stringify({ type: 'status_update', username, online: isOnline });
    activeSockets.forEach((ws, user) => {
        if (user !== username && ws.readyState === WebSocket.OPEN) {
            ws.send(payload);
        }
    });
}

// --- SERVIDOR WEBSOCKET ---
const wss = new WebSocketServer({
    port: PORT,
    maxPayload: MAX_MESSAGE_SIZE_BYTES
});

log.info(`Servidor ZapZap rodando com sucesso na porta ${PORT}`);

wss.on('connection', (ws, req) => {
    const clientIp = req.socket.remoteAddress || 'unknown';
    let currentUsername = null;
    ws.isAlive = true;

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', async (raw) => {
        try {
            // Check Rate-Limit por IP
            if (isRateLimited(clientIp)) {
                ws.send(JSON.stringify({ type: 'error', message: 'Muitas requisições. Aguarde um instante.' }));
                return;
            }

            // Sanitização do Payload JSON
            const payloadStr = raw.toString();
            if (payloadStr.length > MAX_MESSAGE_SIZE_BYTES) {
                ws.send(JSON.stringify({ type: 'error', message: 'Tamanho de mensagem excedeu o limite máximo.' }));
                return;
            }

            const data = JSON.parse(payloadStr);

            // Ping/Pong Keep-Alive
            if (data.type === 'ping') {
                ws.send(JSON.stringify({ type: 'pong' }));
                return;
            }

            switch (data.type) {
                case 'register': {
                    const cleanUser = sanitizeText(data.username).toLowerCase();
                    const rawPassword = sanitizeText(data.password);
                    const displayName = sanitizeText(data.displayName) || cleanUser;
                    const avatar = sanitizeText(data.avatar);

                    if (!cleanUser || !rawPassword || cleanUser.length < 3 || rawPassword.length < 4) {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Usuário ou senha inválidos (Mínimo: 3 caracteres para usuário e 4 para senha).' }));
                        return;
                    }

                    const userCount = db.prepare('SELECT count(*) as count FROM users').get().count;
                    const role = userCount === 0 ? 'Criador' : (cleanUser === 'admin' ? 'Admin' : 'Membro');
                    
                    // Hash seguro de senha com bcrypt
                    const hashedPassword = await bcrypt.hash(rawPassword, 10);
                    const now = Date.now();

                    try {
                        registerTransaction(cleanUser, hashedPassword, displayName, avatar, role, now);
                        
                        currentUsername = cleanUser;
                        activeSockets.set(cleanUser, ws);
                        userCache.set(cleanUser, { displayName, avatar, role });

                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            user: { username: cleanUser, displayName, avatar, role }
                        }));
                        
                        broadcastStatus(cleanUser, true);
                        log.info(`Novo usuário registrado: ${cleanUser} (${role})`);
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Nome de usuário já está em uso.' }));
                    }
                    break;
                }

                case 'login': {
                    const cleanUser = sanitizeText(data.username).toLowerCase();
                    const rawPassword = sanitizeText(data.password);

                    const user = stmtGetUser.get(cleanUser);
                    if (!user) {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Credenciais inválidas.' }));
                        return;
                    }

                    // Comparação segura de hash
                    const isValid = await bcrypt.compare(rawPassword, user.password);
                    if (isValid) {
                        currentUsername = cleanUser;
                        activeSockets.set(cleanUser, ws);
                        userCache.set(cleanUser, { displayName: user.displayName, avatar: user.avatar, role: user.role });

                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            user: { username: user.username, displayName: user.displayName, avatar: user.avatar, role: user.role }
                        }));
                        
                        broadcastStatus(cleanUser, true);
                        log.info(`Usuário autenticado: ${cleanUser}`);
                    } else {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Credenciais inválidas.' }));
                    }
                    break;
                }

                case 'find_user': {
                    if (!currentUsername) return;
                    const targetName = sanitizeText(data.targetUsername).toLowerCase();
                    
                    let target = userCache.get(targetName);
                    if (!target) {
                        const dbUser = stmtGetUser.get(targetName);
                        if (dbUser) {
                            target = { username: dbUser.username, displayName: dbUser.displayName, avatar: dbUser.avatar, role: dbUser.role };
                            userCache.set(targetName, target);
                        }
                    } else {
                        target = { username: targetName, ...target };
                    }

                    if (target) {
                        const history = stmtGetHistoryPrivate.all(currentUsername, target.username, target.username, currentUsername);
                        ws.send(JSON.stringify({
                            type: 'user_found',
                            user: target,
                            history
                        }));
                    } else {
                        ws.send(JSON.stringify({ type: 'user_not_found', targetUsername: targetName }));
                    }
                    break;
                }

                case 'typing': {
                    if (!currentUsername || !data.to) return;
                    const targetWs = activeSockets.get(sanitizeText(data.to).toLowerCase());
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify({ type: 'typing', from: currentUsername }));
                    }
                    break;
                }

                case 'private_message': {
                    if (!currentUsername) return;

                    if (isFlooding(currentUsername)) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Você está enviando mensagens rápido demais.' }));
                        return;
                    }

                    const recipient = sanitizeText(data.to).toLowerCase();
                    const content = sanitizeText(data.content);
                    const mediaType = sanitizeText(data.mediaType) || 'text';

                    if (!recipient || !content) return;

                    const timeStr = data.time || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const timestamp = Date.now();
                    const msgId = crypto.randomUUID(); // Gerador seguro nativo Node.js

                    stmtSaveMsg.run(
                        msgId,
                        currentUsername,
                        recipient,
                        null, // groupId como null para conversas privadas
                        mediaType,
                        content,
                        data.replyTo || null,
                        timeStr,
                        timestamp
                    );

                    const payload = {
                        id: msgId,
                        type: 'chat_message',
                        from: currentUsername,
                        to: recipient,
                        mediaType,
                        content,
                        replyTo: data.replyTo || null,
                        time: timeStr
                    };

                    const targetWs = activeSockets.get(recipient);
                    if (targetWs && targetWs.readyState === WebSocket.OPEN) {
                        targetWs.send(JSON.stringify(payload));
                    }
                    
                    ws.send(JSON.stringify(payload));
                    break;
                }

                default:
                    log.warn(`Tipo de ação desconhecida enviada por ${currentUsername || clientIp}: ${data.type}`);
                    break;
            }
        } catch (e) {
            log.error(`Erro ao processar mensagem do cliente IP ${clientIp}:`, e.message);
            ws.send(JSON.stringify({ type: 'error', message: 'Erro interno ao processar a solicitação.' }));
        }
    });

    ws.on('close', () => {
        if (currentUsername) {
            activeSockets.delete(currentUsername);
            antiFlood.delete(currentUsername);
            broadcastStatus(currentUsername, false);
            log.info(`Conexão encerrada: ${currentUsername}`);
        }
    });

    ws.on('error', (err) => {
        log.error(`Erro na conexão WebSocket (${currentUsername || clientIp}):`, err.message);
    });
});

// Limpeza de conexões inativas (Ping/Pong Heartbeat) a cada 30 segundos
const heartbeat = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) {
            ws.terminate();
            return;
        }
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

// Limpeza periódica de Rate Limits antigos em memória (a cada 5 minutos)
const rateLimitCleaner = setInterval(() => {
    const now = Date.now();
    rateLimits.forEach((record, ip) => {
        if (now - record.lastReset > 60000) {
            rateLimits.delete(ip);
        }
    });
}, 5 * 60 * 1000);

wss.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(rateLimitCleaner);
    db.close();
});
