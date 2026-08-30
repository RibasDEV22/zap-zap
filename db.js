const { createClient } = require('@libsql/client');

// Conexão com a nuvem do Turso usando suas variáveis de ambiente
const db = createClient({
    url: process.env.TURSO_DB_URL,
    authToken: process.env.TURSO_TOKEN
});

const dbPath = 'turso-cloud';

// ============================================================
// POOL DE CACHE PARA REDUZIR QUERIES REPETIDAS
// ============================================================

const userCache = new Map(); // { username -> user_obj }
const userCacheTTL = 60000; // 60 segundos
const messageCacheTTL = 30000; // 30 segundos para mensagens

function invalidateUserCache(username) {
    if (username) {
        userCache.delete(username);
    }
}

function invalidateAllUserCache() {
    userCache.clear();
}

// ============================================================
// INICIALIZAÇÃO DO SCHEMA E MIGRAÇÕES ASSÍNCRONAS
// ============================================================

async function initDb() {
    try {
        await db.execute(`
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
        `);

        await db.execute(`
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
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS announcements (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                message TEXT NOT NULL,
                createdBy TEXT NOT NULL,
                createdAt INTEGER NOT NULL,
                active INTEGER DEFAULT 1
            );
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS system_settings (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS message_reactions (
                message_id INTEGER NOT NULL,
                username TEXT NOT NULL,
                emoji TEXT NOT NULL,
                timestamp INTEGER NOT NULL,
                PRIMARY KEY (message_id, username),
                FOREIGN KEY(message_id) REFERENCES messages(id) ON DELETE CASCADE,
                FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
            );
        `);

        await db.execute(`
            CREATE TABLE IF NOT EXISTS push_subscriptions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT NOT NULL,
                endpoint TEXT NOT NULL UNIQUE,
                p256dh TEXT NOT NULL,
                auth TEXT NOT NULL,
                created_at INTEGER NOT NULL,
                FOREIGN KEY(username) REFERENCES users(username) ON DELETE CASCADE
            );
        `);

        // Índices otimizados para queries frequentes
        await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_pair ON messages(sender, receiver, timestamp DESC);`);
        await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_ts ON messages(timestamp DESC);`);
        await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(receiver, sender, read_at);`);
        await db.execute(`CREATE INDEX IF NOT EXISTS idx_messages_deleted ON messages(deleted_for_all, timestamp);`);
        await db.execute(`CREATE INDEX IF NOT EXISTS idx_announcements_active ON announcements(active, createdAt DESC);`);
        await db.execute(`CREATE INDEX IF NOT EXISTS idx_push_username ON push_subscriptions(username);`);
        await db.execute(`CREATE INDEX IF NOT EXISTS idx_users_username ON users(username);`);

        // Migrações Idempotentes
        const userColsResult = await db.execute("PRAGMA table_info(users);");
        const userCols = userColsResult.rows.map(c => c.name);

        if (!userCols.includes('bio')) await db.execute("ALTER TABLE users ADD COLUMN bio TEXT DEFAULT ''");
        if (!userCols.includes('banned')) await db.execute("ALTER TABLE users ADD COLUMN banned INTEGER DEFAULT 0");
        if (!userCols.includes('restrictedUntil')) await db.execute("ALTER TABLE users ADD COLUMN restrictedUntil INTEGER DEFAULT 0");
        if (!userCols.includes('last_seen')) await db.execute("ALTER TABLE users ADD COLUMN last_seen INTEGER DEFAULT 0");

        const msgColsResult = await db.execute("PRAGMA table_info(messages);");
        const msgCols = msgColsResult.rows.map(c => c.name);

        const addMsgCol = async (name, definition) => {
            if (!msgCols.includes(name)) {
                await db.execute(`ALTER TABLE messages ADD COLUMN ${name} ${definition}`);
            }
        };

        await addMsgCol('msg_type', "TEXT DEFAULT 'text'");
        await addMsgCol('media_meta', 'TEXT');
        await addMsgCol('deleted_for', "TEXT DEFAULT ''");
        await addMsgCol('deleted_for_all', 'INTEGER DEFAULT 0');
        await addMsgCol('reply_to', 'INTEGER');
        await addMsgCol('edited', 'INTEGER DEFAULT 0');
        await addMsgCol('read_at', 'INTEGER');

        const annColsResult = await db.execute("PRAGMA table_info(announcements);");
        const annCols = annColsResult.rows.map(c => c.name);
        if (!annCols.includes('active')) {
            await db.execute("ALTER TABLE announcements ADD COLUMN active INTEGER DEFAULT 1");
        }

        console.log('[TURSO] Conectado e tabelas/migrações verificadas com sucesso!');
    } catch (err) {
        console.error('[TURSO] Erro ao inicializar o banco:', err.message);
        throw err; // importante: propaga o erro para o startServer não subir com DB quebrado
    }
}

// ============================================================
// USERS
// ============================================================

const stmtRegister = {
    run: async (username, password, displayName, avatar, role, bio, createdAt) => {
        try {
            const result = await db.execute({
                sql: `INSERT INTO users (username, password, displayName, avatar, role, bio, createdAt, banned, restrictedUntil)
                      VALUES (?, ?, ?, ?, ?, ?, ?, 0, 0)`,
                args: [username, password, displayName, avatar, role, bio, createdAt]
            });
            invalidateUserCache(username);
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtRegister:', err.message);
            throw err;
        }
    }
};

const stmtGetUser = {
    get: async (username) => {
        // FIX #3.1: Cache simples para reduzir queries repetidas
        const cached = userCache.get(username);
        if (cached && cached.expiresAt > Date.now()) {
            return cached.data;
        }

        try {
            const res = await db.execute({
                sql: `SELECT * FROM users WHERE username = ?`,
                args: [username]
            });
            const user = res.rows[0] || null;
            
            // Armazena em cache com TTL
            if (user) {
                userCache.set(username, {
                    data: user,
                    expiresAt: Date.now() + userCacheTTL
                });
            }
            return user;
        } catch (err) {
            console.error('[DB ERROR] stmtGetUser:', err.message);
            throw err;
        }
    }
};

const stmtGetAllUsers = {
    all: async () => {
        try {
            const res = await db.execute(`
                SELECT username, displayName, avatar, role, bio, last_seen 
                FROM users 
                ORDER BY displayName ASC
            `);
            return res.rows;
        } catch (err) {
            console.error('[DB ERROR] stmtGetAllUsers:', err.message);
            throw err;
        }
    }
};

const stmtGetAdminUsers = {
    all: async () => {
        try {
            const res = await db.execute(`
                SELECT username, displayName, avatar, role, bio, createdAt, banned, restrictedUntil, last_seen 
                FROM users 
                ORDER BY createdAt ASC
            `);
            return res.rows;
        } catch (err) {
            console.error('[DB ERROR] stmtGetAdminUsers:', err.message);
            throw err;
        }
    }
};

const stmtUpdateProfile = {
    run: async (displayName, avatar, bio, username) => {
        try {
            const result = await db.execute({
                sql: `UPDATE users SET displayName = ?, avatar = ?, bio = ? WHERE username = ?`,
                args: [displayName, avatar, bio, username]
            });
            invalidateUserCache(username);
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtUpdateProfile:', err.message);
            throw err;
        }
    }
};

const stmtAdminUpdateUser = {
    run: async (displayName, avatar, username) => {
        try {
            const result = await db.execute({
                sql: `UPDATE users SET displayName = ?, avatar = ? WHERE username = ?`,
                args: [displayName, avatar, username]
            });
            invalidateUserCache(username);
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtAdminUpdateUser:', err.message);
            throw err;
        }
    }
};

const stmtSetUserModeration = {
    run: async (banned, restrictedUntil, username) => {
        try {
            const result = await db.execute({
                sql: `UPDATE users SET banned = ?, restrictedUntil = ? WHERE username = ?`,
                args: [banned, restrictedUntil, username]
            });
            invalidateUserCache(username);
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtSetUserModeration:', err.message);
            throw err;
        }
    }
};

// FIX #3.2: Batching para updateLastSeen reduz overhead
const updateLastSeenQueue = new Map();
let updateLastSeenTimer = null;

async function flushUpdateLastSeen() {
    if (updateLastSeenQueue.size === 0) return;

    const updates = Array.from(updateLastSeenQueue.entries());
    updateLastSeenQueue.clear();

    try {
        // Executa múltiplas atualizações em paralelo
        await Promise.all(
            updates.map(([username, timestamp]) =>
                db.execute({
                    sql: `UPDATE users SET last_seen = ? WHERE username = ?`,
                    args: [timestamp, username]
                }).catch(err => console.error(`[DB ERROR] updateLastSeen for ${username}:`, err.message))
            )
        );
    } catch (err) {
        console.error('[DB ERROR] flushUpdateLastSeen:', err.message);
    }
}

const stmtUpdateLastSeen = {
    run: async (last_seen, username) => {
        try {
            // Agrega múltiplas requisições em um batch
            updateLastSeenQueue.set(username, last_seen);

            // Limpa timeout anterior e cria novo
            if (updateLastSeenTimer) clearTimeout(updateLastSeenTimer);
            updateLastSeenTimer = setTimeout(() => {
                flushUpdateLastSeen();
            }, 5000); // Executa a cada 5 segundos ou quando atinge limite

            if (updateLastSeenQueue.size >= 50) {
                clearTimeout(updateLastSeenTimer);
                updateLastSeenTimer = null;
                await flushUpdateLastSeen();
            }

            return { changes: 1 };
        } catch (err) {
            console.error('[DB ERROR] stmtUpdateLastSeen:', err.message);
            throw err;
        }
    }
};

// ============================================================
// MESSAGES
// ============================================================

const stmtInsertMessage = {
    run: async (sender, receiver, content, timestamp, msg_type, media_meta, reply_to) => {
        try {
            const result = await db.execute({
                sql: `INSERT INTO messages (sender, receiver, content, timestamp, msg_type, media_meta, reply_to)
                      VALUES (?, ?, ?, ?, ?, ?, ?)`,
                args: [sender, receiver, content, timestamp, msg_type, media_meta, reply_to]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtInsertMessage:', err.message);
            throw err;
        }
    }
};

const stmtGetChatHistory = {
    all: async (user1, user2) => {
        try {
            const res = await db.execute({
                sql: `SELECT id, sender, receiver, content, timestamp, msg_type, media_meta,
                             deleted_for, deleted_for_all, reply_to, edited, read_at
                      FROM messages
                      WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?))
                        AND deleted_for_all = 0
                      ORDER BY timestamp DESC
                      LIMIT 200`,
                args: [user1, user2, user2, user1]
            });
            return res.rows.reverse(); // Retorna em ordem ascendente
        } catch (err) {
            console.error('[DB ERROR] stmtGetChatHistory:', err.message);
            throw err;
        }
    }
};

const stmtGetMessageById = {
    get: async (id) => {
        try {
            const res = await db.execute({
                sql: `SELECT * FROM messages WHERE id = ?`,
                args: [id]
            });
            return res.rows[0] || null;
        } catch (err) {
            console.error('[DB ERROR] stmtGetMessageById:', err.message);
            throw err;
        }
    }
};

const stmtSoftDeleteForUser = {
    run: async (val1, val2, val3, id) => {
        try {
            const result = await db.execute({
                sql: `UPDATE messages
                      SET deleted_for = CASE
                          WHEN deleted_for = '' OR deleted_for IS NULL THEN ?
                          WHEN instr(deleted_for, ?) > 0 THEN deleted_for
                          ELSE deleted_for || ',' || ?
                      END
                      WHERE id = ?`,
                args: [val1, val2, val3, id]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtSoftDeleteForUser:', err.message);
            throw err;
        }
    }
};

const stmtDeleteForAll = {
    run: async (id, sender) => {
        try {
            const result = await db.execute({
                sql: `UPDATE messages SET deleted_for_all = 1, content = '', media_meta = NULL WHERE id = ? AND sender = ?`,
                args: [id, sender]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtDeleteForAll:', err.message);
            throw err;
        }
    }
};

const stmtDeleteConversationForUser = {
    run: async (val1, val2, val3, u1, u2, u3, u4) => {
        try {
            const result = await db.execute({
                sql: `UPDATE messages
                      SET deleted_for = CASE
                          WHEN deleted_for = '' OR deleted_for IS NULL THEN ?
                          WHEN instr(deleted_for, ?) > 0 THEN deleted_for
                          ELSE deleted_for || ',' || ?
                      END
                      WHERE (sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)`,
                args: [val1, val2, val3, u1, u2, u3, u4]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtDeleteConversationForUser:', err.message);
            throw err;
        }
    }
};

const stmtDeleteConversationForAll = {
    run: async (u1, u2, u3, u4, sender) => {
        try {
            const result = await db.execute({
                sql: `UPDATE messages SET deleted_for_all = 1, content = '', media_meta = NULL
                      WHERE ((sender = ? AND receiver = ?) OR (sender = ? AND receiver = ?)) AND sender = ?`,
                args: [u1, u2, u3, u4, sender]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtDeleteConversationForAll:', err.message);
            throw err;
        }
    }
};

const stmtEditMessage = {
    run: async (content, id, sender, nowTimestamp) => {
        try {
            const result = await db.execute({
                sql: `UPDATE messages SET content = ?, edited = 1 WHERE id = ? AND sender = ? AND msg_type = 'text' AND (? - timestamp) <= 300000`,
                args: [content, id, sender, nowTimestamp]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtEditMessage:', err.message);
            throw err;
        }
    }
};

const stmtMarkAsRead = {
    all: async (readAt, receiver, sender) => {
        try {
            const res = await db.execute({
                sql: `UPDATE messages SET read_at = ? WHERE receiver = ? AND sender = ? AND read_at IS NULL RETURNING id`,
                args: [readAt, receiver, sender]
            });
            return res.rows;
        } catch (err) {
            console.error('[DB ERROR] stmtMarkAsRead:', err.message);
            throw err;
        }
    }
};

// ============================================================
// REACTIONS
// ============================================================

const stmtUpsertReaction = {
    run: async (message_id, username, emoji, timestamp) => {
        try {
            const result = await db.execute({
                sql: `INSERT INTO message_reactions (message_id, username, emoji, timestamp)
                      VALUES (?, ?, ?, ?)
                      ON CONFLICT(message_id, username) DO UPDATE SET
                          emoji = excluded.emoji,
                          timestamp = excluded.timestamp`,
                args: [message_id, username, emoji, timestamp]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtUpsertReaction:', err.message);
            throw err;
        }
    }
};

const stmtRemoveReaction = {
    run: async (message_id, username) => {
        try {
            const result = await db.execute({
                sql: `DELETE FROM message_reactions WHERE message_id = ? AND username = ?`,
                args: [message_id, username]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtRemoveReaction:', err.message);
            throw err;
        }
    }
};

const stmtGetReactionsByMessage = {
    all: async (message_id) => {
        try {
            const res = await db.execute({
                sql: `SELECT message_id, username, emoji, timestamp FROM message_reactions WHERE message_id = ?`,
                args: [message_id]
            });
            return res.rows;
        } catch (err) {
            console.error('[DB ERROR] stmtGetReactionsByMessage:', err.message);
            throw err;
        }
    }
};

// ============================================================
// PUSH SUBSCRIPTIONS
// ============================================================

const stmtUpsertPushSubscription = {
    run: async (username, endpoint, p256dh, auth, created_at) => {
        try {
            const result = await db.execute({
                sql: `INSERT INTO push_subscriptions (username, endpoint, p256dh, auth, created_at)
                      VALUES (?, ?, ?, ?, ?)
                      ON CONFLICT(endpoint) DO UPDATE SET
                          username = excluded.username,
                          p256dh = excluded.p256dh,
                          auth = excluded.auth,
                          created_at = excluded.created_at`,
                args: [username, endpoint, p256dh, auth, created_at]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtUpsertPushSubscription:', err.message);
            throw err;
        }
    }
};

const stmtGetPushSubscriptionsByUser = {
    all: async (username) => {
        try {
            const res = await db.execute({
                sql: `SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE username = ?`,
                args: [username]
            });
            return res.rows;
        } catch (err) {
            console.error('[DB ERROR] stmtGetPushSubscriptionsByUser:', err.message);
            throw err;
        }
    }
};

const stmtDeletePushSubscriptionByEndpoint = {
    run: async (endpoint) => {
        try {
            const result = await db.execute({
                sql: `DELETE FROM push_subscriptions WHERE endpoint = ?`,
                args: [endpoint]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtDeletePushSubscriptionByEndpoint:', err.message);
            throw err;
        }
    }
};

// ============================================================
// ANNOUNCEMENTS & SETTINGS
// ============================================================

const stmtGetAnnouncements = {
    all: async () => {
        try {
            const res = await db.execute(`
                SELECT id, message, createdBy, createdAt, active 
                FROM announcements 
                WHERE active = 1 
                ORDER BY createdAt DESC 
                LIMIT 20
            `);
            return res.rows;
        } catch (err) {
            console.error('[DB ERROR] stmtGetAnnouncements:', err.message);
            throw err;
        }
    }
};

const stmtInsertAnnouncement = {
    run: async (message, createdBy, createdAt) => {
        try {
            const result = await db.execute({
                sql: `INSERT INTO announcements (message, createdBy, createdAt, active) VALUES (?, ?, ?, 1)`,
                args: [message, createdBy, createdAt]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtInsertAnnouncement:', err.message);
            throw err;
        }
    }
};

const stmtDeactivateAnnouncement = {
    run: async (id) => {
        try {
            const result = await db.execute({
                sql: `UPDATE announcements SET active = 0 WHERE id = ?`,
                args: [id]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtDeactivateAnnouncement:', err.message);
            throw err;
        }
    }
};

const stmtDeleteAnnouncement = {
    run: async (id) => {
        try {
            const result = await db.execute({
                sql: `DELETE FROM announcements WHERE id = ?`,
                args: [id]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtDeleteAnnouncement:', err.message);
            throw err;
        }
    }
};

const stmtGetSetting = {
    get: async (key) => {
        try {
            const res = await db.execute({
                sql: `SELECT value FROM system_settings WHERE key = ?`,
                args: [key]
            });
            return res.rows[0] || null;
        } catch (err) {
            console.error('[DB ERROR] stmtGetSetting:', err.message);
            throw err;
        }
    }
};

const stmtSetSetting = {
    run: async (key, value) => {
        try {
            const result = await db.execute({
                sql: `INSERT INTO system_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
                args: [key, value]
            });
            return result;
        } catch (err) {
            console.error('[DB ERROR] stmtSetSetting:', err.message);
            throw err;
        }
    }
};

// ============================================================
// BACKUP & RESTORE (Gerenciado nativamente pelo Turso)
// ============================================================

async function createDatabaseBackup() {
    console.log('[TURSO] Os backups são gerenciados automaticamente pela nuvem do Turso.');
    return true;
}

async function restoreDatabase() {
    console.log('[TURSO] Restauração física via arquivo .db desativada. Utilize o painel do Turso.');
    return true;
}

async function sendDiscordBackup() {
    console.log('[TURSO] Banco de dados persistente ativado na nuvem.');
}

// ============================================================
// EXPORTS
// ============================================================

module.exports = {
    db,
    dbPath,
    initDb,                     // <-- exportada

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
    sendDiscordBackup,
    
    // Helpers de cache (export para invalidação manual)
    invalidateUserCache,
    invalidateAllUserCache
};
