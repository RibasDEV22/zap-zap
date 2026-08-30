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
db.pragma('foreign_keys = ON');

// ============================================================
// SCHEMA BASE (users, messages, announcements, system_settings)
// ============================================================

db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        displayName TEXT NOT NULL,
        avatar TEXT,
        role TEXT DEFAULT 'Membro',
        bio TEXT DEFAULT '',
        createdAt INTEGER NOT NULL,
        banned INTEGER DEFAULT 0,
        restrictedUntil INTEGER DEFAULT 0,
        last_seen INTEGER DEFAULT 0
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
        read_at INTEGER,
        FOREIGN KEY(sender) REFERENCES users(username),
        FOREIGN KEY(receiver) REFERENCES users(username)
    );

    CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        createdBy TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        active INTEGER DEFAULT 1
    );

    CREATE TABLE IF NOT EXISTS system_settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS message_reactions (
        message_id INTEGER NOT NULL,
        username TEXT NOT NULL,
        emoji TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        PRIMARY KEY (message_id, username),
        FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
        FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL,
        endpoint TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_messages_pair
        ON messages(sender, receiver);

    CREATE INDEX IF NOT EXISTS idx_messages_ts
        ON messages(timestamp);

    CREATE INDEX IF NOT EXISTS idx_messages_read
        ON messages(receiver, sender, read_at);

    CREATE INDEX IF NOT EXISTS idx_announcements_active
        ON announcements(active, createdAt);

    CREATE INDEX IF NOT EXISTS idx_push_username
        ON push_subscriptions(username);
`);

// ============================================================
// MIGRATIONS (idempotentes — nunca apagam dados existentes)
// ============================================================

try {
    const userCols = db.prepare('PRAGMA table_info(users)').all().map(c => c.name);

    if (!userCols.includes('bio')) db.exec(`ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''`);
    if (!userCols.includes('banned')) db.exec(`ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0`);
    if (!userCols.includes('restrictedUntil')) db.exec(`ALTER TABLE users ADD COLUMN restrictedUntil INTEGER DEFAULT 0`);
    if (!userCols.includes('last_seen')) db.exec(`ALTER TABLE users ADD COLUMN last_seen INTEGER DEFAULT 0`);

    const messageCols = db.prepare('PRAGMA table_info(messages)').all().map(c => c.name);

    const addMsgCol = (name, definition) => {
        if (!messageCols.includes(name)) {
            db.exec(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
        }
    };

    addMsgCol('msg_type', "TEXT DEFAULT 'text'");
    addMsgCol('media_meta', 'TEXT');
    addMsgCol('deleted_for', "TEXT DEFAULT ''");
    addMsgCol('deleted_for_all', 'INTEGER DEFAULT 0');
    addMsgCol('reply_to', 'INTEGER');
    addMsgCol('edited', 'INTEGER DEFAULT 0');
