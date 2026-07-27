const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Se estiver no Render e houver um volume persistente em /var/data
const dbDir = process.env.DATA_DIR || './';
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'zapzap.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -2000'); // Limita cache a 2MB RAM

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        displayName TEXT NOT NULL,
        avatar TEXT,
        role TEXT DEFAULT 'Membro',
        createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        receiver TEXT,
        groupId TEXT,
        mediaType TEXT NOT NULL,
        content TEXT NOT NULL,
        replyTo TEXT,
        time TEXT NOT NULL,
        timestamp INTEGER NOT NULL
    );
`);

const stmtRegister = db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)');
const stmtGetUser = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtSaveMsg = db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');

const stmtGetHistoryPrivate = db.prepare(`
    SELECT * FROM (
        SELECT * FROM messages 
        WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
        ORDER BY timestamp DESC LIMIT 50
    ) ORDER BY timestamp ASC
`);

module.exports = {
    db,
    stmtRegister,
    stmtGetUser,
    stmtSaveMsg,
    stmtGetHistoryPrivate
};
