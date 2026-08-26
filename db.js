const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

// Usar disco persistente do Render se existir, senão ./
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
`);

const stmtRegister = db.prepare(
    'INSERT INTO users (username, password, displayName, avatar, role, createdAt) VALUES (?, ?, ?, ?, ?, ?)'
);

const stmtGetUser = db.prepare('SELECT * FROM users WHERE username = ?');
const stmtGetAllUsers = db.prepare('SELECT username, displayName, avatar, role FROM users');

// --- FUNÇÃO DE BACKUP VIA DISCORD WEBHOOK ---
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

        await fetch(webhookUrl, {
            method: 'POST',
            body: formData
        });

        console.log('[Backup Discord] Banco enviado com sucesso.');
    } catch (err) {
        console.error('[Backup Discord Error]', err.message);
    }
}

// Envia um backup a cada 6 horas (21.600.000 ms)
setInterval(sendDiscordBackup, 6 * 60 * 60 * 1000);

module.exports = {
    db,
    stmtRegister,
    stmtGetUser,
    stmtGetAllUsers,
    sendDiscordBackup
};
