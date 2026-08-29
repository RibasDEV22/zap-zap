const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbDir = process.env.DATA_DIR || './';
if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
}

const dbPath = path.join(dbDir, 'zapzap.db');
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('cache_size = -4000');

// Schema + migrations leves
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
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        msg_type TEXT DEFAULT 'text',          -- text | image | audio | video | file
        media_meta TEXT,                       -- JSON: {name, mime, size, duration?}
        deleted_for TEXT DEFAULT '',           -- CSV de usernames que apagaram pra si
        deleted_for_all INTEGER DEFAULT 0,     -- 1 = apagada para todos
        FOREIGN KEY(sender) REFERENCES users(username),
        FOREIGN KEY(receiver) REFERENCES users(username)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender, receiver);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);
`);

// Migration segura para DBs antigos
try {
    const cols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
    if (!cols.includes('msg_type')) {
        db.exec(`ALTER TABLE messages ADD COLUMN msg_type TEXT DEFAULT 'text'`);
    }
    if (!cols.includes('media_meta')) {
        db.exec(`ALTER TABLE messages ADD COLUMN media_meta TEXT`);
    }
    if (!cols.includes('deleted_for')) {
        db.exec(`ALTER TABLE messages ADD COLUMN deleted_for TEXT DEFAULT ''`);
    }
    if (!cols.includes('deleted_for_all')) {
        db.exec(`ALTER TABLE messages ADD COLUMN deleted_for_all INTEGER DEFAULT 0`);
    }
} catch (e) {
    console.warn('[DB] Migration warning:', e.message);
}

const stmtRegister = db.prepare(
    'INSERT INTO users (username, password, displayName, avatar, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
);
const stmtGetUser = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtGetAllUsers = db.prepare('SELECT username, displayName, avatar, role FROM users');

const stmtInsertMessage = db.prepare(`
    INSERT INTO messages (sender, receiver, content, timestamp, msg_type, media_meta)
    VALUES (?, ?, ?, ?, ?, ?)
`);

const stmtGetChatHistory = db.prepare(`
    SELECT id, sender, receiver, content, timestamp, msg_type, media_meta, deleted_for, deleted_for_all
    FROM messages
    WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
      AND deleted_for_all = 0
    ORDER BY timestamp ASC
    LIMIT 150
`);

const stmtSoftDeleteForUser = db.prepare(`
    UPDATE messages
    SET deleted_for = CASE
        WHEN deleted_for = '' OR deleted_for IS NULL THEN ?
        WHEN instr(deleted_for, ?) > 0 THEN deleted_for
        ELSE deleted_for || ',' || ?
    END
    WHERE id = ?
`);

const stmtDeleteForAll = db.prepare(`
    UPDATE messages SET deleted_for_all = 1, content = '', media_meta = NULL
    WHERE id = ? AND sender = ?
`);

const stmtDeleteConversationForUser = db.prepare(`
    UPDATE messages
    SET deleted_for = CASE
        WHEN deleted_for = '' OR deleted_for IS NULL THEN ?
        WHEN instr(deleted_for, ?) > 0 THEN deleted_for
        ELSE deleted_for || ',' || ?
    END
    WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)
`);

const stmtDeleteConversationForAll = db.prepare(`
    UPDATE messages
    SET deleted_for_all = 1, content = '', media_meta = NULL
    WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
      AND sender = ?
`);

// Backup Discord
async function sendDiscordBackup() {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    try {
        if (!fs.existsSync(dbPath)) return;
        const fileBuffer = fs.readFileSync(dbPath);
        const blob = new Blob([fileBuffer], { type: 'application/x-sqlite3' });
        const formData = new FormData();
        formData.append('file', blob, 'zapzap_backup.db');
        formData.append('payload_json', JSON.stringify({
            content: `📦 **Backup do Banco de Dados** | ${new Date().toLocaleString('pt-BR')}`
        }));
        await fetch(webhookUrl, { method: 'POST', body: formData });
        console.log('[Backup Discord] Banco de dados exportado com sucesso.');
    } catch (err) {
        console.error('[Backup Discord Error]', err.message);
    }
}

setInterval(sendDiscordBackup, 6 * 60 * 60 * 1000);

module.exports = {
    db,
    dbPath,
    stmtRegister,
    stmtGetUser,
    stmtGetAllUsers,
    stmtInsertMessage,
    stmtGetChatHistory,
    stmtSoftDeleteForUser,
    stmtDeleteForAll,
    stmtDeleteConversationForUser,
    stmtDeleteConversationForAll,
    sendDiscordBackup
};
