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

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        displayName TEXT NOT NULL,
        avatar TEXT,
        role TEXT DEFAULT 'Membro',
        bio TEXT DEFAULT '',
        createdAt INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        msg_type TEXT DEFAULT 'text',
        media_meta TEXT,
        deleted_for TEXT DEFAULT '',
        deleted_for_all INTEGER DEFAULT 0,
        reply_to INTEGER,
        edited INTEGER DEFAULT 0,
        FOREIGN KEY(sender) REFERENCES users(username),
        FOREIGN KEY(receiver) REFERENCES users(username)
    );

    CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender, receiver);
    CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp);
`);

// Migrations seguras
try {
    const userCols = db.prepare("PRAGMA table_info(users)").all().map(c => c.name);
    if (!userCols.includes('bio')) {
        db.exec(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`);
    }

    const cols = db.prepare("PRAGMA table_info(messages)").all().map(c => c.name);
    const addCol = (name, def) => {
        if (!cols.includes(name)) db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${def}`);
    };
    addCol('msg_type', "TEXT DEFAULT 'text'");
    addCol('media_meta', 'TEXT');
    addCol('deleted_for', "TEXT DEFAULT ''");
    addCol('deleted_for_all', 'INTEGER DEFAULT 0');
    addCol('reply_to', 'INTEGER');
    addCol('edited', 'INTEGER DEFAULT 0');
} catch (e) {
    console.warn('[DB] Migration:', e.message);
}

const stmtRegister = db.prepare(
    'INSERT INTO users (username, password, displayName, avatar, role, bio, createdAt) VALUES (?, ?, ?, ?, ?, ?, ?)'
);
const stmtGetUser = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtGetAllUsers = db.prepare('SELECT username, displayName, avatar, role, bio FROM users');
const stmtUpdateProfile = db.prepare(
    'UPDATE users SET displayName = ?, avatar = ?, bio = ? WHERE username = ?'
);

const stmtInsertMessage = db.prepare(`
    INSERT INTO messages (sender, receiver, content, timestamp, msg_type, media_meta, reply_to)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const stmtGetChatHistory = db.prepare(`
    SELECT id, sender, receiver, content, timestamp, msg_type, media_meta,
           deleted_for, deleted_for_all, reply_to, edited
    FROM messages
    WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
      AND deleted_for_all = 0
    ORDER BY timestamp ASC
    LIMIT 200
`);

const stmtGetMessageById = db.prepare('SELECT * FROM messages WHERE id = ?');

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

const stmtEditMessage = db.prepare(`
    UPDATE messages SET content = ?, edited = 1
    WHERE id = ? AND sender = ? AND msg_type = 'text'
      AND (? - timestamp) <= 300000
`);

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
            content: `📦 **Backup** | ${new Date().toLocaleString('pt-BR')}`
        }));
        await fetch(webhookUrl, { method: 'POST', body: formData });
    } catch (err) {
        console.error('[Backup]', err.message);
    }
}

setInterval(sendDiscordBackup, 6 * 60 * 60 * 1000);

module.exports = {
    db, dbPath,
    stmtRegister, stmtGetUser, stmtGetAllUsers, stmtUpdateProfile,
    stmtInsertMessage, stmtGetChatHistory, stmtGetMessageById,
    stmtSoftDeleteForUser, stmtDeleteForAll,
    stmtDeleteConversationForUser, stmtDeleteConversationForAll,
    stmtEditMessage, sendDiscordBackup
};
