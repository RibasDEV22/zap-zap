const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, 'zapzap.db');
const db = new Database(dbPath);

// Otimizações de desempenho e concorrência do SQLite
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

// ============================================================
// SCHEMA — USERS E MESSAGES
// ============================================================
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'Membro',
        banned INTEGER DEFAULT 0,
        restrictedUntil INTEGER DEFAULT 0,
        avatar TEXT,
        bio TEXT
    );

    CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        sender TEXT NOT NULL,
        recipient TEXT,
        content TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT DEFAULT 'text',
        fileUrl TEXT,
        fileName TEXT,
        fileSize INTEGER,
        edited INTEGER DEFAULT 0,
        editedAt INTEGER,
        deleted_for TEXT DEFAULT '[]',
        deleted_for_all INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_messages_timestamp ON messages(timestamp);
    CREATE INDEX IF NOT EXISTS idx_messages_sender ON messages(sender);
    CREATE INDEX IF NOT EXISTS idx_messages_recipient ON messages(recipient);
`);

// ============================================================
// SCHEMA — RECADOS (ANNOUNCEMENTS) E CONFIGURAÇÕES (SETTINGS)
// ============================================================
db.exec(`
    CREATE TABLE IF NOT EXISTS announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        message TEXT NOT NULL,
        createdAt INTEGER NOT NULL,
        createdBy TEXT NOT NULL,
        active INTEGER DEFAULT 1
    );

    CREATE INDEX IF NOT EXISTS idx_announcements_active
        ON announcements(active, createdAt);

    CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
    );
`);

// Garante linha default de manutenção sem sobrescrever se já existir (idempotente)
try {
    const maintenanceExists = db
        .prepare('SELECT 1 FROM settings WHERE key = ?')
        .get('maintenance_mode');

    if (!maintenanceExists) {
        db.prepare(
            'INSERT INTO settings (key, value) VALUES (?, ?)'
        ).run('maintenance_mode', JSON.stringify({ active: false, message: '' }));
    }
} catch (err) {
    console.warn('[DB] Settings init:', err.message);
}

// ============================================================
// PREPARED STATEMENTS — USERS
// ============================================================
const stmtRegister = db.prepare(`
    INSERT INTO users (username, password, role, avatar, bio)
    VALUES (?, ?, ?, ?, ?)
`);

const stmtGetUser = db.prepare(`
    SELECT * FROM users WHERE username = ?
`);

const stmtGetAllUsers = db.prepare(`
    SELECT id, username, role, banned, restrictedUntil, avatar, bio FROM users
`);

const stmtGetAdminUsers = db.prepare(`
    SELECT username FROM users WHERE role IN ('Admin', 'Criador')
`);

const stmtUpdateProfile = db.prepare(`
    UPDATE users
    SET avatar = COALESCE(?, avatar),
        bio = COALESCE(?, bio)
    WHERE username = ?
`);

const stmtAdminUpdateUser = db.prepare(`
    UPDATE users
    SET role = COALESCE(?, role),
        avatar = COALESCE(?, avatar),
        bio = COALESCE(?, bio)
    WHERE username = ?
`);

const stmtSetUserModeration = db.prepare(`
    UPDATE users
    SET banned = COALESCE(?, banned),
        restrictedUntil = COALESCE(?, restrictedUntil)
    WHERE username = ?
`);

// ============================================================
// PREPARED STATEMENTS — MESSAGES
// ============================================================
const stmtInsertMessage = db.prepare(`
    INSERT INTO messages (id, sender, recipient, content, timestamp, type, fileUrl, fileName, fileSize)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const stmtGetChatHistory = db.prepare(`
    SELECT * FROM messages
    WHERE (recipient IS NULL OR recipient = '' OR sender = ? OR recipient = ?)
      AND deleted_for_all = 0
    ORDER BY timestamp DESC
    LIMIT 100
`);

const stmtGetMessageById = db.prepare(`
    SELECT * FROM messages WHERE id = ?
`);

const stmtSoftDeleteForUser = db.prepare(`
    UPDATE messages SET deleted_for = ? WHERE id = ?
`);

const stmtDeleteForAll = db.prepare(`
    UPDATE messages SET deleted_for_all = 1 WHERE id = ?
`);

const stmtDeleteConversationForUser = db.prepare(`
    UPDATE messages SET deleted_for = ? WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
`);

const stmtDeleteConversationForAll = db.prepare(`
    UPDATE messages SET deleted_for_all = 1 WHERE (sender = ? AND recipient = ?) OR (sender = ? AND recipient = ?)
`);

const stmtEditMessage = db.prepare(`
    UPDATE messages SET content = ?, edited = 1, editedAt = ? WHERE id = ?
`);

// ============================================================
// PREPARED STATEMENTS — ANNOUNCEMENTS (RECADOS)
// ============================================================
const stmtInsertAnnouncement = db.prepare(`
    INSERT INTO announcements (message, createdAt, createdBy, active)
    VALUES (?, ?, ?, 1)
`);

const stmtGetActiveAnnouncements = db.prepare(`
    SELECT id, message, createdAt, createdBy
    FROM announcements
    WHERE active = 1
    ORDER BY createdAt DESC
    LIMIT 20
`);

const stmtGetAllAnnouncements = db.prepare(`
    SELECT id, message, createdAt, createdBy, active
    FROM announcements
    ORDER BY createdAt DESC
    LIMIT 100
`);

const stmtDeactivateAnnouncement = db.prepare(`
    UPDATE announcements
    SET active = 0
    WHERE id = ?
`);

const stmtDeleteAnnouncement = db.prepare(`
    DELETE FROM announcements
    WHERE id = ?
`);

// ============================================================
// PREPARED STATEMENTS & FUNÇÕES — SETTINGS (MANUTENÇÃO)
// ============================================================
const stmtGetSetting = db.prepare(`
    SELECT value FROM settings WHERE key = ?
`);

const stmtSetSetting = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value
`);

function getMaintenanceMode() {
    try {
        const row = stmtGetSetting.get('maintenance_mode');
        if (!row) return { active: false, message: '' };
        const parsed = JSON.parse(row.value);
        return {
            active: !!parsed.active,
            message: parsed.message || ''
        };
    } catch (err) {
        console.warn('[DB] getMaintenanceMode:', err.message);
        return { active: false, message: '' };
    }
}

function setMaintenanceMode(active, message) {
    const value = JSON.stringify({
        active: !!active,
        message: String(message || '').slice(0, 300)
    });
    stmtSetSetting.run('maintenance_mode', value);
    return getMaintenanceMode();
}

// ============================================================
// BACKUP E RESTAURAÇÃO
// ============================================================
function createDatabaseBackup(destinationPath) {
    db.backup(destinationPath);
}

function restoreDatabase(sourcePath) {
    db.close();
    fs.copyFileSync(sourcePath, dbPath);
    return new Database(dbPath);
}

function sendDiscordBackup(webhookUrl) {
    if (!webhookUrl) return;
    const backupFile = path.join(__dirname, `backup_${Date.now()}.db`);
    try {
        db.backup(backupFile);
        console.log('[DB] Backup gerado para envio ao Discord:', backupFile);
    } catch (err) {
        console.error('[DB] Erro no backup do Discord:', err);
    } finally {
        if (fs.existsSync(backupFile)) {
            fs.unlinkSync(backupFile);
        }
    }
}

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

    stmtInsertMessage,
    stmtGetChatHistory,
    stmtGetMessageById,

    stmtSoftDeleteForUser,
    stmtDeleteForAll,
    stmtDeleteConversationForUser,
    stmtDeleteConversationForAll,

    stmtEditMessage,

    // Recados
    stmtInsertAnnouncement,
    stmtGetActiveAnnouncements,
    stmtGetAllAnnouncements,
    stmtDeactivateAnnouncement,
    stmtDeleteAnnouncement,

    // Manutenção
    getMaintenanceMode,
    setMaintenanceMode,

    createDatabaseBackup,
    restoreDatabase,
    sendDiscordBackup
};
