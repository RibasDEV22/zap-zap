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
    addMsgCol('read_at', 'INTEGER');

    const announcementCols = db.prepare('PRAGMA table_info(announcements)').all().map(c => c.name);
    if (!announcementCols.includes('active')) {
        db.exec(`ALTER TABLE announcements ADD COLUMN active INTEGER DEFAULT 1`);
    }
} catch (err) {
    console.warn('[DB] Migration:', err.message);
}

// ============================================================
// USERS
// ============================================================

const stmtRegister = db.prepare(`
    INSERT INTO users (username, password, displayName, avatar, role, bio, createdAt, banned, restrictedUntil)
    VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)
`);

const stmtGetUser = db.prepare(`SELECT * FROM users WHERE username = ?`);

const stmtGetAllUsers = db.prepare(`
    SELECT username, displayName, avatar, role, bio, last_seen
    FROM users
`);

const stmtGetAdminUsers = db.prepare(`
    SELECT username, displayName, avatar, role, bio, createdAt, banned, restrictedUntil, last_seen
    FROM users
    ORDER BY createdAt ASC
`);

const stmtUpdateProfile = db.prepare(`
    UPDATE users SET displayName = ?, avatar = ?, bio = ? WHERE username = ?
`);

const stmtAdminUpdateUser = db.prepare(`
    UPDATE users SET displayName = ?, avatar = ? WHERE username = ?
`);

const stmtSetUserModeration = db.prepare(`
    UPDATE users SET banned = ?, restrictedUntil = ? WHERE username = ?
`);

const stmtUpdateLastSeen = db.prepare(`
    UPDATE users SET last_seen = ? WHERE username = ?
`);

// ============================================================
// MESSAGES
// ============================================================

const stmtInsertMessage = db.prepare(`
    INSERT INTO messages (sender, receiver, content, timestamp, msg_type, media_meta, reply_to)
    VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const stmtGetChatHistory = db.prepare(`
    SELECT id, sender, receiver, content, timestamp, msg_type, media_meta,
           deleted_for, deleted_for_all, reply_to, edited, read_at
    FROM messages
    WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
      AND deleted_for_all = 0
    ORDER BY timestamp ASC
    LIMIT 200
`);

const stmtGetMessageById = db.prepare(`SELECT * FROM messages WHERE id = ?`);

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
    UPDATE messages SET deleted_for_all = 1, content = '', media_meta = NULL
    WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)) AND sender = ?
`);

const stmtEditMessage = db.prepare(`
    UPDATE messages SET content = ?, edited = 1
    WHERE id = ? AND sender = ? AND msg_type = 'text' AND (? - timestamp) <= 300000
`);

// Confirmação de leitura — trava dupla: só marca msgs onde eu sou o receiver
// e o remetente é exatamente quem o client informou. RETURNING evita um
// SELECT extra antes do UPDATE.
const stmtMarkAsRead = db.prepare(`
    UPDATE messages
    SET read_at = ?
    WHERE receiver = ? AND sender = ? AND read_at IS NULL
    RETURNING id
`);

// ============================================================
// REACTIONS (upsert = toggle de emoji; remove = tirar reação)
// ============================================================

const stmtUpsertReaction = db.prepare(`
    INSERT INTO message_reactions (message_id, username, emoji, timestamp)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(message_id, username) DO UPDATE SET
        emoji = excluded.emoji,
        timestamp = excluded.timestamp
`);

const stmtRemoveReaction = db.prepare(`
    DELETE FROM message_reactions WHERE message_id = ? AND username = ?
`);

const stmtGetReactionsByMessage = db.prepare(`
    SELECT message_id, username, emoji, timestamp
    FROM message_reactions
    WHERE message_id = ?
`);

// ============================================================
// PUSH SUBSCRIPTIONS (chave por endpoint — suporta N dispositivos/conta)
// ============================================================

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
    DELETE FROM push_subscriptions WHERE endpoint = ?
`);

// ============================================================
// ANNOUNCEMENTS & SETTINGS
// ============================================================

const stmtGetAnnouncements = db.prepare(`
    SELECT id, message, createdBy, createdAt, active
    FROM announcements
    WHERE active = 1
    ORDER BY createdAt DESC
    LIMIT 20
`);

const stmtInsertAnnouncement = db.prepare(`
    INSERT INTO announcements (message, createdBy, createdAt, active)
    VALUES (?, ?, ?, 1)
`);

const stmtDeactivateAnnouncement = db.prepare(`
    UPDATE announcements SET active = 0 WHERE id = ?
`);

const stmtDeleteAnnouncement = db.prepare(`
    DELETE FROM announcements WHERE id = ?
`);

const stmtGetSetting = db.prepare(`SELECT value FROM system_settings WHERE key = ?`);

const stmtSetSetting = db.prepare(`
    INSERT INTO system_settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

// ============================================================
// BACKUP & RESTORE
// ============================================================

async function createDatabaseBackup(destination) {
    if (!destination) throw new Error('Destino do backup nao informado.');
    await db.backup(destination);
    return destination;
}

async function restoreDatabase(sourcePath) {
    if (!sourcePath || !fs.existsSync(sourcePath)) {
        throw new Error('Arquivo de backup nao encontrado.');
    }

    const source = new Database(sourcePath, { readonly: true, fileMustExist: true });

    try {
        const tables = source.prepare(`
            SELECT name FROM sqlite_master
            WHERE type = 'table' AND name IN ('users', 'messages')
        `).all().map(row => row.name);

        if (!tables.includes('users') || !tables.includes('messages')) {
            throw new Error('Backup invalido: tabelas do ZapZap nao encontradas.');
        }

        const users = source.prepare(`
            SELECT username, password, displayName, avatar, role, bio, createdAt,
                   COALESCE(banned, 0) AS banned,
                   COALESCE(restrictedUntil, 0) AS restrictedUntil,
                   COALESCE(last_seen, 0) AS last_seen
            FROM users
        `);

        const messages = source.prepare(`
            SELECT id, sender, receiver, content, timestamp,
                   COALESCE(msg_type, 'text') AS msg_type,
                   media_meta,
                   COALESCE(deleted_for, '') AS deleted_for,
                   COALESCE(deleted_for_all, 0) AS deleted_for_all,
                   reply_to,
                   COALESCE(edited, 0) AS edited,
                   read_at
            FROM messages
        `);

        const insertUser = db.prepare(`
            INSERT INTO users (username, password, displayName, avatar, role, bio, createdAt, banned, restrictedUntil, last_seen)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const insertMessage = db.prepare(`
            INSERT INTO messages (id, sender, receiver, content, timestamp, msg_type, media_meta, deleted_for, deleted_for_all, reply_to, edited, read_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const restoreTransaction = db.transaction(() => {
            db.pragma('foreign_keys = OFF');
            db.exec('DELETE FROM message_reactions');
            db.exec('DELETE FROM messages');
            db.exec('DELETE FROM users');

            for (const user of users.iterate()) {
                insertUser.run(
                    user.username, user.password, user.displayName, user.avatar,
                    user.role, user.bio || '', user.createdAt,
                    user.banned || 0, user.restrictedUntil || 0, user.last_seen || 0
                );
            }

            for (const message of messages.iterate()) {
                insertMessage.run(
                    message.id, message.sender, message.receiver, message.content,
                    message.timestamp, message.msg_type || 'text', message.media_meta,
                    message.deleted_for || '', message.deleted_for_all || 0,
                    message.reply_to, message.edited || 0, message.read_at
                );
            }

            db.pragma('foreign_keys = ON');
        });

        restoreTransaction();
    } finally {
        source.close();
    }

    return true;
}

async function sendDiscordBackup() {
    const webhookUrl = process.env.DISCORD_WEBHOOK_URL;
    if (!webhookUrl) return;

    const backupPath = path.join(dbDir, `.zapzap-backup-${process.pid}-${Date.now()}.db`);

    try {
        await createDatabaseBackup(backupPath);
        const fileBuffer = fs.readFileSync(backupPath);
        const blob = new Blob([fileBuffer], { type: 'application/x-sqlite3' });
        const formData = new FormData();

        formData.append('file', blob, 'zapzap_backup.db');
        formData.append('payload_json', JSON.stringify({
            content: `📦 **ZapZap Backup** | ${new Date().toLocaleString('pt-BR')}`
        }));

        await fetch(webhookUrl, { method: 'POST', body: formData });
    } catch (err) {
        console.error('[Backup]', err.message);
    } finally {
        try { if (fs.existsSync(backupPath)) fs.unlinkSync(backupPath); } catch {}
    }
}

setInterval(sendDiscordBackup, 6 * 60 * 60 * 1000);

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    db,
    dbPath,

    stmtRegister,
    stmtGetUser,
    stmtGetAllUsers,
    stmtGetAdminUsers,
    stmtUpdateProfile,
    stmtAdminUpdateUser,
    stmtSetUserModeration,
    stmtUpdateLastSeen,

    stmtInsertMessage,
    stmtGetChatHistory,
    stmtGetMessageById,
    stmtSoftDeleteForUser,
    stmtDeleteForAll,
    stmtDeleteConversationForUser,
    stmtDeleteConversationForAll,
    stmtEditMessage,
    stmtMarkAsRead,

    stmtUpsertReaction,
    stmtRemoveReaction,
    stmtGetReactionsByMessage,

    stmtUpsertPushSubscription,
    stmtGetPushSubscriptionsByUser,
    stmtDeletePushSubscriptionByEndpoint,

    stmtGetAnnouncements,
    stmtInsertAnnouncement,
    stmtDeactivateAnnouncement,
    stmtDeleteAnnouncement,
    stmtGetSetting,
    stmtSetSetting,

    createDatabaseBackup,
    restoreDatabase,
    sendDiscordBackup
};
