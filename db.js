const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Se estiver no Render com um Disk persistente, use DATA_DIR (ex: /var/data)
const dbDir = process.env.DATA_DIR || './';
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'zapzap.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -2000'); // ~2MB de cache

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        displayName TEXT NOT NULL,
        avatar TEXT,
        role TEXT DEFAULT 'Membro',
        createdAt INTEGER NOT NULL
    );

    -- Chat único de grupo: sem "to_user", toda mensagem é pra todo mundo
    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_user TEXT NOT NULL,
        mediaType TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL,
        replyTo TEXT,
        time TEXT NOT NULL,
        timestamp INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
`);

// Avatares NÃO ficam mais na tabela de mensagens nem são reenviados
// em cada broadcast de user_list — evita inchar payloads e o banco.

const stmtRegister = db.prepare(
    'INSERT INTO users (username, password, displayName, avatar, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
);

const stmtGetUser = db.prepare('SELECT * FROM users WHERE username = ?');

const stmtSaveMsg = db.prepare(
    'INSERT INTO messages (id, from_user, mediaType, content, replyTo, time, timestamp) VALUES (?, ?, ?, ?, ?, ?, ?)'
);

// Só traz as últimas N mensagens do grupo (histórico não deve crescer sem limite na tela)
const stmtGetHistory = db.prepare(`
    SELECT m.*, u.displayName, u.avatar
    FROM messages m
    LEFT JOIN users u ON u.username = m.from_user
    ORDER BY m.timestamp DESC
    LIMIT ?
`);

const stmtGetAllUsers = db.prepare('SELECT username, displayName, avatar, role FROM users');

module.exports = {
    db,
    stmtRegister,
    stmtGetUser,
    stmtSaveMsg,
    stmtGetHistory,
    stmtGetAllUsers
};
