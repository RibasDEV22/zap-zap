const Database = require('better-sqlite3');
const path = require('path');

const db = new Database(path.join(__dirname, 'zapzap.db'));

// Otimizações de performance e integridade referencial
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Inicialização das Tabelas e Índices
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        displayName TEXT NOT NULL,
        last_seen INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        sender TEXT NOT NULL,
        receiver TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'text',
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        read_at INTEGER,
        FOREIGN KEY(sender) REFERENCES users(username) ON DELETE CASCADE,
        FOREIGN KEY(receiver) REFERENCES users(username) ON DELETE CASCADE
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

    CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(sender, receiver);
    CREATE INDEX IF NOT EXISTS idx_push_username ON push_subscriptions(username);
    CREATE INDEX IF NOT EXISTS idx_reactions_message ON message_reactions(message_id);
`);

// Verificação de Migrações
const userCols = db.pragma('table_info(users)').map(col => col.name);
if (!userCols.includes('last_seen')) {
    db.exec(`ALTER TABLE users ADD COLUMN last_seen INTEGER DEFAULT 0`);
}

const msgCols = db.pragma('table_info(messages)').map(col => col.name);
if (!msgCols.includes('read_at')) {
    db.exec(`ALTER TABLE messages ADD COLUMN read_at INTEGER`);
}

// Prepared Statements
const stmtInsertUser = db.prepare(`INSERT INTO users (username, password, displayName) VALUES (?, ?, ?)`);
const stmtGetUser = db.prepare(`SELECT * FROM users WHERE username = ?`);
const stmtGetAllUsers = db.prepare(`SELECT username, displayName, last_seen FROM users`);

const stmtInsertMessage = db.prepare(`
    INSERT INTO messages (sender, receiver, type, content, timestamp)
    VALUES (?, ?, ?, ?, ?)
`);

const stmtGetMessageById = db.prepare(`SELECT * FROM messages WHERE id = ?`);

const stmtGetConversation = db.prepare(`
    SELECT m.*, 
           (SELECT JSON_GROUP_ARRAY(JSON_OBJECT('username', r.username, 'emoji', r.emoji))
            FROM message_reactions r WHERE r.message_id = m.id) as reactions
    FROM messages m
    WHERE (m.sender = ? AND m.receiver = ?) OR (m.sender = ? AND m.receiver = ?)
    ORDER BY m.timestamp ASC
`);

const stmtMarkAsRead = db.prepare(`
    UPDATE messages
    SET read_at = ?
    WHERE receiver = ? AND sender = ? AND read_at IS NULL
    RETURNING id
`);

const stmtUpsertReaction = db.prepare(`
    INSERT INTO message_reactions (message_id, username, emoji, timestamp)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, username) DO UPDATE SET
        emoji = excluded.emoji,
        timestamp = excluded.timestamp
`);

const stmtGetReactionsByMessage = db.prepare(`
    SELECT message_id, username, emoji, timestamp
    FROM message_reactions
    WHERE message_id = ?
`);

const stmtUpdateLastSeen = db.prepare(`
    UPDATE users
    SET last_seen = ?
    WHERE username = ?
`);

const stmtUpsertPushSubscription = db.prepare(`
    INSERT INTO push_subscriptions (username, endpoint, p256dh, auth, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET
        username = excluded.username,
        p256dh = excluded.p256dh,
        auth = excluded.auth,
        created_at = excluded.created_at
`);

const stmtGetPushSubscriptionsByUser = db.prepare(`
    SELECT id, endpoint, p256dh, auth
    FROM push_subscriptions
    WHERE username = ?
`);

const stmtDeletePushSubscriptionByEndpoint = db.prepare(`
    DELETE FROM push_subscriptions
    WHERE endpoint = ?
`);

module.exports = {
    db,
    stmtInsertUser,
    stmtGetUser,
    stmtGetAllUsers,
    stmtInsertMessage,
    stmtGetMessageById,
    stmtGetConversation,
    stmtMarkAsRead,
    stmtUpsertReaction,
    stmtGetReactionsByMessage,
    stmtUpdateLastSeen,
    stmtUpsertPushSubscription,
    stmtGetPushSubscriptionsByUser,
    stmtDeletePushSubscriptionByEndpoint
};
