// server.js - Otimizado para máquinas de 512MB RAM
const { WebSocketServer, WebSocket } = require('ws');
const Database = require('better-sqlite3');

const PORT = process.env.PORT || 8080;

// Inicializa banco SQLite (Persistente e ultra-leve em memória)
const db = new Database('zapzap.db');
db.pragma('journal_mode = WAL'); // Garante performance máxima em I/O

// Cria tabelas de Usuários e Mensagens caso não existam
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
`);

// Prepared statements reutilizáveis para evitar overhead de parsing
const stmtRegister = db.prepare('INSERT INTO users (username, password, displayName, avatar, role) VALUES (?, ?, ?, ?, ?)');
const stmtGetUser = db.prepare('SELECT username, password, displayName, avatar, role FROM users WHERE username = ?');
const stmtSaveMsg = db.prepare('INSERT INTO messages (sender, receiver, mediaType, content, time, timestamp) VALUES (?, ?, ?, ?, ?, ?)');
const stmtGetHistory = db.prepare(`
    SELECT * FROM (
        SELECT sender, receiver, mediaType, content, time, timestamp 
        FROM messages 
        WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
        ORDER BY id DESC LIMIT 40
    ) ORDER BY id ASC
`);

// Mapeamento em memória APENAS das conexões ativas: { username: WebSocket }
const activeSockets = new Map();

const wss = new WebSocketServer({ 
    port: PORT,
    maxPayload: 15 * 1024 * 1024 // Limite estrito de 15MB por mensagem para não estourar a RAM
});

console.log(`[ZapZap Server] Rodando com suporte SQLite na porta ${PORT}...`);

wss.on('connection', (ws) => {
    let currentUsername = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                // REGISTRO DE NOVO USUÁRIO
                case 'register': {
                    const cleanUser = data.username.trim().toLowerCase();
                    if (!cleanUser || !data.password) return;

                    // Definição de Cargos/Patentes
                    // O primeiro usuário a se registrar vira automaticamente 'Criador'
                    const userCount = db.prepare('SELECT count(*) as count FROM users').get().count;
                    let role = 'Membro';
                    if (userCount === 0) role = 'Criador';
                    else if (cleanUser === 'admin') role = 'Admin';

                    try {
                        stmtRegister.run(cleanUser, data.password, data.displayName || cleanUser, data.avatar || '', role);
                        
                        currentUsername = cleanUser;
                        activeSockets.set(cleanUser, ws);

                        ws.send(JSON.stringify({
                            type: 'auth_success',
                            user: { username: cleanUser, displayName: data.displayName || cleanUser, avatar: data.avatar || '', role }
                        }));
                        console.log(`[ZapZap] Novo registro: @${cleanUser} (${role})`);
                    } catch (err) {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Este nome de usuário já está registrado!' }));
                    }
                    break;
                }

                // LOGIN DE USUÁRIO EXISTENTE
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
                        console.log(`[ZapZap] Login efetuado: @${cleanUser}`);
                    } else {
                        ws.send(JSON.stringify({ type: 'auth_error', message: 'Usuário ou senha incorretos!' }));
                    }
                    break;
                }

                // BUSCA DE USUÁRIO PARA INICIAR CHAT
                case 'find_user': {
                    const targetUser = stmtGetUser.get(data.targetUsername.trim().toLowerCase());
                    if (targetUser) {
                        // Carrega as últimas 40 mensagens gravadas no banco
                        const history = stmtGetHistory.all(currentUsername, targetUser.username, targetUser.username, currentUsername);
                        ws.send(JSON.stringify({
                            type: 'user_found',
                            user: { username: targetUser.username, displayName: targetUser.displayName, avatar: targetUser.avatar, role: targetUser.role },
                            history
                        }));
                    } else {
                        ws.send(JSON.stringify({ type: 'user_not_found', targetUsername: data.targetUsername }));
                    }
                    break;
                }

                // MENSAGEM PRIVADA (Com gravação no SQLite)
                case 'private_message': {
                    if (!currentUsername) return;

                    const recipientUsername = data.to.trim().toLowerCase();
                    const timeStr = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                    const timestamp = Date.now();

                    // 1. Salva no banco de dados
                    stmtSaveMsg.run(currentUsername, recipientUsername, data.mediaType || 'text', data.content, timeStr, timestamp);

                    const payload = {
                        type: 'chat_message',
                        from: currentUsername,
                        to: recipientUsername,
                        mediaType: data.mediaType || 'text',
                        content: data.content,
                        time: timeStr
                    };

                    // 2. Transmite ao vivo para o destinatário (se estiver online)
                    const recipientSocket = activeSockets.get(recipientUsername);
                    if (recipientSocket && recipientSocket.readyState === WebSocket.OPEN) {
                        recipientSocket.send(JSON.stringify(payload));
                    }

                    // 3. Devolve confirmação para o próprio remetente
                    ws.send(JSON.stringify(payload));
                    break;
                }
            }
        } catch (err) {
            console.error('[ZapZap Erro]', err);
        }
    });

    ws.on('close', () => {
        if (currentUsername) activeSockets.delete(currentUsername);
    });
});
