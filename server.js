const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const { WebSocketServer, WebSocket } = require('ws');

let webPush = null;
try {
    webPush = require('web-push');
} catch (e) {
    console.warn('[PUSH] Módulo web-push não instalado. Notificações nativas offline ficarão desativadas.');
}

const { authenticateUser, registerUser } = require('./auth');
const {
    initDb,                         // <-- importada
    stmtGetAllUsers,
    stmtGetAdminUsers,
    stmtGetUser,
    stmtInsertMessage,
    stmtGetChatHistory,
    stmtGetMessageById,
    stmtSoftDeleteForUser,
    stmtDeleteForAll,
    stmtDeleteConversationForUser,
    stmtDeleteConversationForAll,
    stmtUpdateProfile,
    stmtAdminUpdateUser,
    stmtSetUserModeration,
    stmtEditMessage,
    stmtGetAnnouncements,
    stmtInsertAnnouncement,
    stmtDeactivateAnnouncement,
    stmtGetSetting,
    stmtSetSetting,
    stmtMarkAsRead,
    stmtUpsertReaction,
    stmtRemoveReaction,
    stmtGetReactionsByMessage,
    stmtUpdateLastSeen,
    stmtUpsertPushSubscription,
    stmtGetPushSubscriptionsByUser,
    stmtDeletePushSubscriptionByEndpoint,
    db,
    dbPath,
    createDatabaseBackup,
    restoreDatabase
} = require('./db');

const PORT = process.env.PORT || 8080;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const MAX_MEDIA_BASE64 = 2.8 * 1024 * 1024;
const MAX_ADMIN_BODY = 110 * 1024 * 1024;
const ADMIN_SESSION_TIME = 24 * 60 * 60 * 1000;
const ADMIN_HTML_PATH = path.join(__dirname, 'admin.html');

// Cache para último update de last_seen (debounce a DB)
const lastSeenCache = new Map();
const LAST_SEEN_DEBOUNCE_MS = 30000; // 30 segundos

const VAPID_PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY;
const VAPID_PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY;
const VAPID_SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@zapzap.local';

if (webPush && VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
    webPush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

const activeSockets = new Map();
const adminSessions = new Map();

// ============================================================
// MANUTENÇÃO & HELPER DE STAFF
// ============================================================

let maintenanceState = { active: false, message: 'Servidor em manutenção.' };

async function isStaff(username) {
    if (!username) return false;
    const user = await stmtGetUser.get(username);
    return user && (user.role === 'Criador' || user.role === 'Admin');
}

async function setMaintenanceMode(active, message) {
    maintenanceState = {
        active: !!active,
        message: message || 'Servidor em manutenção.'
    };

    await stmtSetSetting.run('maintenance', JSON.stringify(maintenanceState));

    if (maintenanceState.active) {
        for (const [username, session] of activeSockets.entries()) {
            if (!(await isStaff(username))) {
                send(session.ws, {
                    type: 'maintenance_active',
                    message: maintenanceState.message
                });
                try { session.ws.close(); } catch {}
                activeSockets.delete(username);
            }
        }
        await broadcastUserList();
    }

    const payloadStr = JSON.stringify({
        type: 'maintenance_status',
        ...maintenanceState
    });

    for (const { ws } of activeSockets.values()) {
        if (ws.readyState === WebSocket.OPEN) {
            ws.send(payloadStr);
        }
    }
}

// ============================================================
// HELPERS HTTP & WEB PUSH
// ============================================================

async function sendPushNotification(targetUsername, payload) {
    if (!webPush || !VAPID_PUBLIC_KEY || !VAPIC_PRIVATE_KEY) return;

    try {
        const subscriptions = await stmtGetPushSubscriptionsByUser.all(targetUsername);
        if (!subscriptions || subscriptions.length === 0) return;

        const pushData = JSON.stringify(payload);

        subscriptions.forEach(sub => {
            const pushConfig = {
                endpoint: sub.endpoint,
                keys: {
                    p256dh: sub.p256dh,
                    auth: sub.auth
                }
            };

            webPush.sendNotification(pushConfig, pushData)
                .catch(err => {
                    if (err.statusCode === 410 || err.statusCode === 404) {
                        stmtDeletePushSubscriptionByEndpoint.run(sub.endpoint).catch(() => {});
                    }
                });
        });
    } catch (err) {
        console.error('[PUSH ERROR]', err.message);
    }
}

function sendJson(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });
    res.end(JSON.stringify(data));
}

function sendText(res, status, text) {
    res.writeHead(status, {
        'Content-Type': 'text/plain; charset=utf-8'
    });
    res.end(text);
}

function readBody(req, maxBytes = MAX_ADMIN_BODY) {
    return new Promise((resolve, reject) => {
        let size = 0;
        const chunks = [];

        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxBytes) {
                reject(new Error('Requisicao muito grande.'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });

        req.on('end', () => resolve(Buffer.concat(chunks)));
        req.on('error', reject);
    });
}

function getCookies(req) {
    const header = req.headers.cookie || '';
    const cookies = {};

    for (const part of header.split(';')) {
        const index = part.indexOf('=');
        if (index === -1) continue;
        const key = part.slice(0, index).trim();
        const value = part.slice(index + 1).trim();
        cookies[key] = decodeURIComponent(value);
    }
    return cookies;
}

function isAdminSession(req) {
    const cookies = getCookies(req);
    const token = cookies.zapzap_admin;
    if (!token) return false;

    const session = adminSessions.get(token);
    if (!session) return false;

    if (session.expiresAt < Date.now()) {
        adminSessions.delete(token);
        return false;
    }
    return true;
}

function createAdminSession() {
    const token = crypto.randomBytes(32).toString('hex');
    adminSessions.set(token, {
        createdAt: Date.now(),
        expiresAt: Date.now() + ADMIN_SESSION_TIME
    });
    return token;
}

function timingSafePasswordCheck(password) {
    if (!ADMIN_PASSWORD) return false;
    const a = crypto.createHash('sha256').update(String(password)).digest();
    const b = crypto.createHash('sha256').update(String(ADMIN_PASSWORD)).digest();
    return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res) {
    if (!isAdminSession(req)) {
        sendJson(res, 401, { error: 'Nao autorizado.' });
        return false;
    }
    return true;
}

function closeUserSocket(username, reason) {
    const session = activeSockets.get(username);
    if (!session) return;

    send(session.ws, {
        type: 'auth_error',
        message: reason
    });

    try { session.ws.close(); } catch {}
}

function parseJsonBody(buffer) {
    try {
        return JSON.parse(buffer.toString('utf8'));
    } catch {
        throw new Error('JSON invalido.');
    }
}

// ============================================================
// HELPERS PARA LAST_SEEN (DEBOUNCE)
// ============================================================

async function updateLastSeenDebounced(username) {
    const now = Date.now();
    const lastUpdate = lastSeenCache.get(username) || 0;

    if (now - lastUpdate >= LAST_SEEN_DEBOUNCE_MS) {
        lastSeenCache.set(username, now);
        stmtUpdateLastSeen.run(now, username).catch(() => {});
    }
}

// ============================================================
// ADMIN HTTP API
// ============================================================

async function handleAdminRequest(req, res, pathname) {
    if (pathname === '/admin/api/login' && req.method === 'POST') {
        if (!ADMIN_PASSWORD) {
            return sendJson(res, 503, { error: 'ADMIN_PASSWORD nao configurada no servidor.' });
        }

        try {
            const body = parseJsonBody(await readBody(req, 32 * 1024));
            if (!timingSafePasswordCheck(body.password)) {
                return sendJson(res, 401, { error: 'Senha administrativa incorreta.' });
            }

            const token = createAdminSession();
            const secure = req.headers['x-forwarded-proto'] === 'https' ? '; Secure' : '';

            res.writeHead(200, {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Set-Cookie': `zapzap_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${Math.floor(ADMIN_SESSION_TIME / 1000)}${secure}`
            });

            return res.end(JSON.stringify({ success: true }));
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }

    if (pathname === '/admin/api/logout' && req.method === 'POST') {
        const cookies = getCookies(req);
        if (cookies.zapzap_admin) {
            adminSessions.delete(cookies.zapzap_admin);
        }

        res.writeHead(200, {
            'Content-Type': 'application/json',
            'Set-Cookie': 'zapzap_admin=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0'
        });

        return res.end(JSON.stringify({ success: true }));
    }

    if (pathname.startsWith('/admin/api/')) {
        if (!requireAdmin(req, res)) return;
    }

    if (pathname === '/admin/api/status' && req.method === 'GET') {
        const users = await stmtGetAdminUsers.all();
        return sendJson(res, 200, {
            success: true,
            users,
            onlineUsers: activeSockets.size,
            uptime: Math.floor(process.uptime()),
            database: dbPath,
            maintenance: maintenanceState
        });
    }

    if (pathname === '/admin/api/maintenance' && req.method === 'POST') {
        try {
            const body = parseJsonBody(await readBody(req, 32 * 1024));
            await setMaintenanceMode(body.active, body.message);
            return sendJson(res, 200, {
                success: true,
                maintenance: maintenanceState
            });
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }

    if (pathname === '/admin/api/announcements' && req.method === 'GET') {
        const items = await stmtGetAnnouncements.all();
        return sendJson(res, 200, { success: true, items });
    }

    if (pathname === '/admin/api/announcements' && req.method === 'POST') {
        try {
            const body = parseJsonBody(await readBody(req, 64 * 1024));
            const msg = String(body.message || '').trim().slice(0, 1000);
            if (!msg) return sendJson(res, 400, { error: 'Mensagem vazia.' });

            const now = Date.now();
            const info = await stmtInsertAnnouncement.run(msg, 'Admin', now);

            const payloadStr = JSON.stringify({
                type: 'announcement_new',
                id: info.lastInsertRowid || (info.rows && info.rows[0] && info.rows[0].id) || null,
                message: msg,
                createdAt: now
            });

            for (const session of activeSockets.values()) {
                if (session.ws.readyState === WebSocket.OPEN) {
                    session.ws.send(payloadStr);
                }
            }

            return sendJson(res, 200, {
                success: true,
                id: info.lastInsertRowid || (info.rows && info.rows[0] && info.rows[0].id) || null
            });
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }

    if (pathname === '/admin/api/announcements/deactivate' && req.method === 'POST') {
        try {
            const body = parseJsonBody(await readBody(req, 16 * 1024));
            const id = Number(body.id);
            if (!id) return sendJson(res, 400, { error: 'ID invalido.' });

            await stmtDeactivateAnnouncement.run(id);

            const payloadStr = JSON.stringify({
                type: 'announcement_removed',
                id
            });

            for (const session of activeSockets.values()) {
                if (session.ws.readyState === WebSocket.OPEN) {
                    session.ws.send(payloadStr);
                }
            }

            return sendJson(res, 200, { success: true, id });
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }

    if (pathname === '/admin/api/user/moderation' && req.method === 'POST') {
        try {
            const body = parseJsonBody(await readBody(req, 32 * 1024));
            const username = String(body.username || '').toLowerCase().trim();

            if (!username) {
                return sendJson(res, 400, { error: 'Usuario obrigatorio.' });
            }

            const user = await stmtGetUser.get(username);
            if (!user) {
                return sendJson(res, 404, { error: 'Usuario nao encontrado.' });
            }

            if (user.role === 'Criador') {
                return sendJson(res, 403, { error: 'O Criador nao pode ser moderado por este painel.' });
            }

            const banned = body.banned ? 1 : 0;
            let restrictedUntil = Number(body.restrictedUntil) || 0;
            if (restrictedUntil < Date.now()) restrictedUntil = 0;

            await stmtSetUserModeration.run(banned, restrictedUntil, username);

            if (banned) {
                closeUserSocket(username, 'Sua conta foi banida.');
            }

            return sendJson(res, 200, {
                success: true,
                username,
                banned: !!banned,
                restrictedUntil
            });
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }

    if (pathname === '/admin/api/user/profile' && req.method === 'POST') {
        try {
            const body = parseJsonBody(await readBody(req, 600 * 1024));
            const username = String(body.username || '').toLowerCase().trim();
            const displayName = String(body.displayName || '').trim().slice(0, 30);
            const avatar = String(body.avatar || '');

            if (!username) return sendJson(res, 400, { error: 'Usuario obrigatorio.' });
            if (!displayName) return sendJson(res, 400, { error: 'Nome de exibicao obrigatorio.' });
            if (avatar.length > 400 * 1024) return sendJson(res, 400, { error: 'Avatar muito grande.' });

            const result = await stmtAdminUpdateUser.run(displayName, avatar, username);
            if (!result.rowsAffected && !(result.changes > 0)) {
                return sendJson(res, 404, { error: 'Usuario nao encontrado.' });
            }

            const session = activeSockets.get(username);
            if (session) {
                session.displayName = displayName;
                send(session.ws, {
                    type: 'profile_updated',
                    user: { username, displayName, avatar }
                });
            }

            await broadcastUserList();
            return sendJson(res, 200, { success: true });
        } catch (err) {
            return sendJson(res, 400, { error: err.message });
        }
    }

    if (pathname === '/admin/api/backup' && req.method === 'GET') {
        // Turso gerencia backups automaticamente
        return sendJson(res, 200, {
            success: true,
            message: 'Backups são gerenciados automaticamente pelo Turso. Use o painel do Turso para download.'
        });
    }

    if (pathname === '/admin/api/restore' && req.method === 'POST') {
        return sendJson(res, 400, {
            error: 'Restauração via arquivo .db desativada no Turso. Utilize o painel do Turso.'
        });
    }

    return sendJson(res, 404, { error: 'Endpoint administrativo nao encontrado.' });
}

// ============================================================
// HTTP SERVER
// ============================================================

const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const pathname = url.pathname;

    if (pathname === '/admin' || pathname === '/admin/') {
        if (!fs.existsSync(ADMIN_HTML_PATH)) {
            return sendText(res, 500, 'admin.html nao encontrado.');
        }
        res.writeHead(200, {
            'Content-Type': 'text/html; charset=utf-8',
            'Cache-Control': 'no-store'
        });
        return res.end(fs.readFileSync(ADMIN_HTML_PATH));
    }

    if (pathname.startsWith('/admin/api/')) {
        return handleAdminRequest(req, res, pathname);
    }

    if (pathname === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('pong');
    }

    if (pathname === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'OK',
            onlineUsers: activeSockets.size,
            uptime: Math.floor(process.uptime()),
            maintenance: maintenanceState.active
        }));
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Servidor ZapZap');
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

if (RENDER_URL) {
    setInterval(async () => {
        try { await fetch(RENDER_URL + '/ping'); } catch {}
    }, 10 * 60 * 1000);
}

// ============================================================
// WEBSOCKET
// ============================================================

const wss = new WebSocketServer({ server });

const pingInterval = setInterval(() => {
    wss.clients.forEach(ws => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

wss.on('close', () => clearInterval(pingInterval));

function send(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(payload));
    }
}

function sendError(ws, message) {
    send(ws, { type: 'auth_error', message });
}

async function getUsersData() {
    try {
        const rows = await stmtGetAllUsers.all();
        return rows.map(u => ({
            username: u.username,
            displayName: u.displayName,
            avatar: u.avatar,
            role: u.role,
            bio: u.bio || '',
            online: activeSockets.has(u.username),
            last_seen: u.last_seen || 0
        }));
    } catch {
        return [];
    }
}

async function broadcastUserList() {
    const users = await getUsersData();
    for (const { ws } of activeSockets.values()) {
        send(ws, { type: 'users_list', users });
        send(ws, { type: 'contacts_list', users });
    }
}

function endUserCall(username) {
    const session = activeSockets.get(username);
    if (!session) return;

    const target = session.callTarget;
    session.isBusy = false;
    session.callTarget = null;

    if (target) {
        const t = activeSockets.get(target);
        if (t) {
            t.isBusy = false;
            t.callTarget = null;
            send(t.ws, { type: 'call_ended', from: username });
        }
    }
}

function isDeletedForUser(msg, username) {
    if (msg.deleted_for_all) return true;
    if (!msg.deleted_for) return false;
    return msg.deleted_for.split(',').includes(username);
}

async function getCurrentUserStatus(username) {
    const user = await stmtGetUser.get(username);
    if (!user) {
        return { exists: false, banned: false, restrictedUntil: 0, restricted: false };
    }
    const restrictedUntil = Number(user.restrictedUntil) || 0;
    return {
        exists: true,
        banned: !!user.banned,
        restrictedUntil,
        restricted: restrictedUntil > Date.now()
    };
}

async function checkRestricted(ws, username) {
    const status = await getCurrentUserStatus(username);
    if (!status.exists) {
        sendError(ws, 'Conta nao encontrada.');
        return true;
    }
    if (status.banned) {
        sendError(ws, 'Sua conta foi banida.');
        try { ws.close(); } catch {}
        return true;
    }
    if (status.restricted) {
        send(ws, {
            type: 'account_restricted',
            restrictedUntil: status.restrictedUntil,
            message: 'Sua conta esta temporariamente restrita.'
        });
        return true;
    }
    return false;
}

// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

wss.on('connection', ws => {
    ws.isAlive = true;
    let currentUsername = null;
    let sessionId = crypto.randomBytes(8).toString('hex'); // ID único da sessão

    ws.on('pong', () => {
        ws.isAlive = true;
        // FIX #1.3: Remove atualização SQL aqui - mantém apenas flag de vida
        // updateLastSeenDebounced é chamado apenas em eventos de tráfego
    });

    ws.on('message', async raw => {
        let data;

        // FIX #1.2: Renova flag de vida em qualquer tráfego
        ws.isAlive = true;
        if (currentUsername) {
            updateLastSeenDebounced(currentUsername).catch(() => {});
        }

        try {
            data = JSON.parse(raw.toString());
        } catch {
            return sendError(ws, 'JSON invalido.');
        }

        try {
            switch (data.type) {
                case 'ping':
                    ws.isAlive = true;
                    return send(ws, { type: 'pong' });

                // --------------------
                // LOGIN
                // --------------------
                case 'login': {
                    const user = await authenticateUser(data.username, data.password);

                    if (maintenanceState.active && !(await isStaff(user.username))) {
                        return send(ws, {
                            type: 'maintenance_active',
                            message: maintenanceState.message
                        });
                    }

                    if (activeSockets.has(user.username)) {
                        const old = activeSockets.get(user.username).ws;
                        send(old, {
                            type: 'auth_error',
                            message: 'Nova conexao em outro dispositivo.'
                        });
                        old.close();
                    }

                    currentUsername = user.username;
                    activeSockets.set(currentUsername, {
                        ws,
                        displayName: user.displayName,
                        isBusy: false,
                        callTarget: null,
                        focused: true,
                        sessionId // Armazena ID único da sessão
                    });

                    await updateLastSeenDebounced(currentUsername);

                    send(ws, {
                        type: 'auth_success',
                        user: Object.assign({}, user, { bio: user.bio || '' }),
                        credentials: { username: data.username, password: data.password }
                    });

                    await broadcastUserList();
                    break;
                }

                // --------------------
                // REGISTER
                // --------------------
                case 'register': {
                    const user = await registerUser(
                        data.username,
                        data.password,
                        data.displayName,
                        data.avatar
                    );

                    if (maintenanceState.active && !(await isStaff(user.username))) {
                        return send(ws, {
                            type: 'maintenance_active',
                            message: maintenanceState.message
                        });
                    }

                    currentUsername = user.username;
                    activeSockets.set(currentUsername, {
                        ws,
                        displayName: user.displayName,
                        isBusy: false,
                        callTarget: null,
                        focused: true,
                        sessionId // Armazena ID único da sessão
                    });

                    await updateLastSeenDebounced(currentUsername);

                    send(ws, {
                        type: 'auth_success',
                        user: Object.assign({}, user, { bio: '' }),
                        credentials: { username: data.username, password: data.password }
                    });

                    await broadcastUserList();
                    break;
                }

                // --------------------
                // APP VISIBILITY
                // --------------------
                case 'app_visibility': {
                    if (!currentUsername) return;
                    const session = activeSockets.get(currentUsername);
                    if (session) {
                        session.focused = !!data.focused;
                    }
                    break;
                }

                // --------------------
                // ANNOUNCEMENTS & MAINTENANCE (WS CLIENT QUERY)
                // --------------------
                case 'get_announcements': {
                    const items = await stmtGetAnnouncements.all();
                    send(ws, {
                        type: 'announcements_list',
                        items
                    });
                    break;
                }

                case 'get_maintenance_status': {
                    send(ws, {
                        type: 'maintenance_status',
                        ...maintenanceState
                    });
                    break;
                }

                // --------------------
                // PROFILE
                // --------------------
                case 'update_profile': {
                    if (!currentUsername) return;
                    if (await checkRestricted(ws, currentUsername)) return;

                    const displayName = (data.displayName || '').trim().slice(0, 30);
                    const bio = (data.bio || '').trim().slice(0, 200);
                    const avatar = data.avatar || '';

                    if (!displayName) {
                        return send(ws, {
                            type: 'profile_error',
                            message: 'Nome de exibicao obrigatorio.'
                        });
                    }

                    await stmtUpdateProfile.run(displayName, avatar, bio, currentUsername);
                    const session = activeSockets.get(currentUsername);
                    if (session) session.displayName = displayName;

                    send(ws, {
                        type: 'profile_updated',
                        user: { username: currentUsername, displayName, avatar, bio }
                    });

                    await broadcastUserList();
                    break;
                }

                // --------------------
                // USERS
                // --------------------
                case 'get_contacts':
                case 'get_users':
                    send(ws, {
                        type: 'contacts_list',
                        users: await getUsersData()
                    });
                    break;

                // --------------------
                // CHAT
                // --------------------
                case 'chat_message': {
                    if (!currentUsername || !data.to) return;
                    if (await checkRestricted(ws, currentUsername)) return;

                    const msgType = data.msg_type || 'text';
                    let content = (data.text || '').trim();
                    let mediaMeta = null;

                    if (data.media) {
                        if (typeof data.media !== 'string' || data.media.length > MAX_MEDIA_BASE64) {
                            return send(ws, {
                                type: 'chat_error',
                                message: 'Arquivo muito grande apos compressao.'
                            });
                        }
                        content = data.media;
                        mediaMeta = JSON.stringify({
                            name: data.fileName || 'arquivo',
                            mime: data.mime || 'application/octet-stream',
                            size: data.media.length,
                            duration: data.duration || null
                        });
                    }

                    if (!content) return;

                    const timestamp = Date.now();
                    const replyTo = data.reply_to ? Number(data.reply_to) : null;
                    const info = await stmtInsertMessage.run(
                        currentUsername,
                        data.to,
                        content,
                        timestamp,
                        msgType,
                        mediaMeta,
                        replyTo
                    );

                    let replyPreview = null;
                    if (replyTo) {
                        const orig = await stmtGetMessageById.get(replyTo);
                        if (orig) {
                            replyPreview = {
                                id: orig.id,
                                sender: orig.sender,
                                content: orig.msg_type === 'text'
                                    ? (orig.content || '').slice(0, 80)
                                    : '[' + orig.msg_type + ']',
                                msg_type: orig.msg_type
                            };
                        }
                    }

                    const lastId = info.lastInsertRowid || (info.rows && info.rows[0] && info.rows[0].id) || null;

                    const payload = {
                        type: 'chat_message',
                        id: lastId,
                        from: currentUsername,
                        to: data.to,
                        text: msgType === 'text' ? content : null,
                        media: msgType !== 'text' ? content : null,
                        msg_type: msgType,
                        media_meta: mediaMeta ? JSON.parse(mediaMeta) : null,
                        timestamp,
                        reply_to: replyTo,
                        reply_preview: replyPreview,
                        edited: false
                    };

                    // FIX #2.1: Entrega de mensagens com fallback em fila
                    const targetSession = activeSockets.get(data.to);
                    if (targetSession && targetSession.ws && targetSession.ws.readyState === WebSocket.OPEN) {
                        send(targetSession.ws, payload);
                    } else {
                        // Destinatário offline - client retentará ou usará push notifications
                        console.log(`[MSG DELIVERY] Mensagem para ${data.to} não entregue imediatamente (usuário offline ou desconectado).`);
                    }

                    send(ws, Object.assign({}, payload, { confirmed: true }));

                    if (!targetSession || !targetSession.focused) {
                        sendPushNotification(data.to, {
                            title: `Nova mensagem de @${currentUsername}`,
                            body: msgType === 'text' ? content.slice(0, 100) : `[${msgType}]`,
                            icon: '/icon.png',
                            data: { sender: currentUsername }
                        }).catch(() => {});
                    }
                    break;
                }

                // --------------------
                // EDIT
                // --------------------
                case 'edit_message': {
                    if (!currentUsername || !data.messageId || !data.text) return;
                    if (await checkRestricted(ws, currentUsername)) return;

                    const text = String(data.text).trim().slice(0, 2000);
                    if (!text) return;

                    const result = await stmtEditMessage.run(text, data.messageId, currentUsername, Date.now());
                    const changed = (result.rowsAffected > 0) || (result.changes > 0);

                    if (changed) {
                        const payload = {
                            type: 'message_edited',
                            messageId: data.messageId,
                            text,
                            by: currentUsername
                        };
                        send(ws, payload);
                        if (data.withUser) {
                            const t = activeSockets.get(data.withUser);
                            if (t && t.ws && t.ws.readyState === WebSocket.OPEN) {
                                send(t.ws, payload);
                            }
                        }
                    } else {
                        send(ws, {
                            type: 'chat_error',
                            message: 'Nao foi possivel editar (limite 5 min ou nao e sua).'
                        });
                    }
                    break;
                }

                // --------------------
                // MARK AS READ
                // --------------------
                case 'mark_as_read': {
                    if (!currentUsername || !data.withUser) return;

                    const readRows = await stmtMarkAsRead.all(Date.now(), currentUsername, data.withUser);

                    if (readRows && readRows.length > 0) {
                        const readIds = readRows.map(r => r.id);
                        const payload = {
                            type: 'messages_read',
                            withUser: currentUsername,
                            ids: readIds
                        };

                        const senderSession = activeSockets.get(data.withUser);
                        if (senderSession && senderSession.ws && senderSession.ws.readyState === WebSocket.OPEN) {
                            send(senderSession.ws, payload);
                        }
                    }
                    break;
                }

                // --------------------
                // ADD REACTION
                // --------------------
                case 'add_reaction': {
                    if (!currentUsername || !data.messageId || !data.emoji) return;
                    if (await checkRestricted(ws, currentUsername)) return;

                    const msg = await stmtGetMessageById.get(data.messageId);
                    if (!msg || (msg.sender !== currentUsername && msg.receiver !== currentUsername)) {
                        return send(ws, { type: 'chat_error', message: 'Mensagem invalida ou sem permissao.' });
                    }

                    const timestamp = Date.now();
                    await stmtUpsertReaction.run(data.messageId, currentUsername, data.emoji, timestamp);

                    const payload = {
                        type: 'reaction_updated',
                        messageId: data.messageId,
                        username: currentUsername,
                        emoji: data.emoji,
                        timestamp
                    };

                    const targetUser = msg.sender === currentUsername ? msg.receiver : msg.sender;
                    const targetSession = activeSockets.get(targetUser);

                    if (targetSession && targetSession.ws && targetSession.ws.readyState === WebSocket.OPEN) {
                        send(targetSession.ws, payload);
                    }
                    send(ws, payload);
                    break;
                }

                // --------------------
                // PUSH SUBSCRIPTION
                // --------------------
                case 'save_push_subscription': {
                    if (!currentUsername || !data.subscription) return;
                    const { endpoint, keys } = data.subscription;
                    if (!endpoint || !keys || !keys.p256dh || !keys.auth) return;

                    await stmtUpsertPushSubscription.run(
                        currentUsername,
                        endpoint,
                        keys.p256dh,
                        keys.auth,
                        Date.now()
                    );
                    break;
                }

                // --------------------
                // HISTORY
                // --------------------
                case 'get_chat_history': {
                    if (!currentUsername || !data.withUser) return;
                    const history = await stmtGetChatHistory.all(
                        currentUsername,
                        data.withUser
                    );

                    const filtered = [];
                    for (const m of history) {
                        if (isDeletedForUser(m, currentUsername)) continue;

                        let reply_preview = null;
                        if (m.reply_to) {
                            const orig = await stmtGetMessageById.get(m.reply_to);
                            if (orig) {
                                reply_preview = {
                                    id: orig.id,
                                    sender: orig.sender,
                                    content: orig.msg_type === 'text'
                                        ? (orig.content || '').slice(0, 80)
                                        : '[' + orig.msg_type + ']',
                                    msg_type: orig.msg_type
                                };
                            }
                        }

                        let reactions = [];
                        try {
                            reactions = await stmtGetReactionsByMessage.all(m.id);
                        } catch (e) {}

                        filtered.push({
                            id: m.id,
                            sender: m.sender,
                            content: m.deleted_for_all ? null : m.content,
                            timestamp: m.timestamp,
                            msg_type: m.msg_type || 'text',
                            media_meta: m.media_meta ? JSON.parse(m.media_meta) : null,
                            deleted_for_all: !!m.deleted_for_all,
                            reply_to: m.reply_to,
                            reply_preview,
                            edited: !!m.edited,
                            reactions
                        });
                    }

                    send(ws, {
                        type: 'chat_history',
                        withUser: data.withUser,
                        messages: filtered
                    });
                    break;
                }

                // --------------------
                // REMOVE REACTION
                // --------------------
                case 'remove_reaction': {
                    if (!currentUsername || !data.messageId) return;

                    const msg = await stmtGetMessageById.get(data.messageId);
                    if (!msg || (msg.sender !== currentUsername && msg.receiver !== currentUsername)) return;

                    await stmtRemoveReaction.run(data.messageId, currentUsername);

                    const payload = {
                        type: 'reaction_removed',
                        messageId: data.messageId,
                        username: currentUsername
                    };

                    const targetUser = msg.sender === currentUsername ? msg.receiver : msg.sender;
                    const targetSession = activeSockets.get(targetUser);

                    if (targetSession && targetSession.ws && targetSession.ws.readyState === WebSocket.OPEN) {
                        send(targetSession.ws, payload);
                    }
                    send(ws, payload);
                    break;
                }

                // --------------------
                // DELETE MESSAGE
                // --------------------
                case 'delete_message': {
                    if (!currentUsername || !data.messageId) return;
                    if (await checkRestricted(ws, currentUsername)) return;

                    const forAll = !!data.forAll;
                    if (forAll) {
                        const r = await stmtDeleteForAll.run(data.messageId, currentUsername);
                        const changed = (r.rowsAffected > 0) || (r.changes > 0);
                        if (changed) {
                            const payload = {
                                type: 'message_deleted',
                                messageId: data.messageId,
                                forAll: true,
                                by: currentUsername
                            };
                            send(ws, payload);
                            if (data.withUser) {
                                const t = activeSockets.get(data.withUser);
                                if (t && t.ws && t.ws.readyState === WebSocket.OPEN) {
                                    send(t.ws, payload);
                                }
                            }
                        }
                    } else {
                        await stmtSoftDeleteForUser.run(
                            currentUsername,
                            currentUsername,
                            currentUsername,
                            data.messageId
                        );
                        send(ws, {
                            type: 'message_deleted',
                            messageId: data.messageId,
                            forAll: false,
                            by: currentUsername
                        });
                    }
                    break;
                }

                // --------------------
                // DELETE CONVERSATION
                // --------------------
                case 'delete_conversation': {
                    if (!currentUsername || !data.withUser) return;
                    if (await checkRestricted(ws, currentUsername)) return;

                    const forAll = !!data.forAll;
                    if (forAll) {
                        await stmtDeleteConversationForAll.run(
                            currentUsername,
                            data.withUser,
                            data.withUser,
                            currentUsername,
                            currentUsername
                        );
                        const payload = {
                            type: 'conversation_deleted',
                            withUser: data.withUser,
                            forAll: true,
                            by: currentUsername
                        };
                        send(ws, payload);
                        const t = activeSockets.get(data.withUser);
                        if (t && t.ws && t.ws.readyState === WebSocket.OPEN) {
                            send(t.ws, payload);
                        }
                    } else {
                        await stmtDeleteConversationForUser.run(
                            currentUsername,
                            currentUsername,
                            currentUsername,
                            currentUsername,
                            data.withUser,
                            data.withUser,
                            currentUsername
                        );
                        send(ws, {
                            type: 'conversation_deleted',
                            withUser: data.withUser,
                            forAll: false,
                            by: currentUsername
                        });
                    }
                    break;
                }

                // --------------------
                // CALL (WEBRTC SIGNALING)
                // --------------------
                case 'call_initiate':
                case 'call_user': {
                    if (!currentUsername) return;
                    if (await checkRestricted(ws, currentUsername)) return;

                    const targetUsername = data.callee || data.to;
                    const callee = activeSockets.get(targetUsername);
                    const caller = activeSockets.get(currentUsername);

                    // FIX #2.2: Validação corrigida - verifica se o socket está realmente ativo
                    if (!callee || !callee.ws || callee.ws.readyState !== WebSocket.OPEN) {
                        return send(ws, { type: 'call_offline', callee: targetUsername });
                    }

                    if (callee.isBusy || (caller && caller.isBusy)) {
                        return send(ws, { type: 'call_error', message: 'Usuario ocupado.' });
                    }

                    if (caller) {
                        caller.isBusy = true;
                        caller.callTarget = targetUsername;
                    }
                    if (callee) {
                        callee.isBusy = true;
                        callee.callTarget = currentUsername;
                    }

                    send(callee.ws, {
                        type: 'call_incoming',
                        caller: currentUsername,
                        callerDisplayName: caller ? caller.displayName : 'Desconhecido',
                        offer: data.offer || data.signal,
                        isVideo: !!data.isVideo
                    });
                    break;
                }

                case 'call_answer':
                case 'call_response': {
                    if (!currentUsername) return;
                    if (await checkRestricted(ws, currentUsername)) return;

                    const targetUsername = data.caller || data.to;
                    const caller = activeSockets.get(targetUsername);
                    const answerer = activeSockets.get(currentUsername);

                    if (data.accepted === false) {
                        endUserCall(currentUsername);
                        if (caller && caller.ws && caller.ws.readyState === WebSocket.OPEN) {
                            send(caller.ws, { type: 'call_rejected', from: currentUsername });
                        }
                        break;
                    }

                    if (answerer) {
                        answerer.isBusy = true;
                        answerer.callTarget = targetUsername;
                    }

                    if (caller && caller.ws && caller.ws.readyState === WebSocket.OPEN) {
                        caller.isBusy = true;
                        caller.callTarget = currentUsername;
                        send(caller.ws, {
                            type: 'call_answered',
                            answerer: currentUsername,
                            answer: data.answer || data.signal
                        });
                    }
                    break;
                }

                case 'call_reject': {
                    if (!currentUsername) return;
                    const targetUsername = data.caller || data.to;
                    endUserCall(currentUsername);
                    const caller = activeSockets.get(targetUsername);
                    if (caller && caller.ws && caller.ws.readyState === WebSocket.OPEN) {
                        send(caller.ws, { type: 'call_rejected', from: currentUsername });
                    }
                    break;
                }

                case 'call_ice_candidate':
                case 'ice_candidate': {
                    if (!currentUsername) return;
                    const targetUsername = data.to;
                    const t = activeSockets.get(targetUsername);
                    if (t && t.ws && t.ws.readyState === WebSocket.OPEN) {
                        send(t.ws, {
                            type: 'call_ice_candidate',
                            from: currentUsername,
                            candidate: data.candidate
                        });
                    }
                    break;
                }

                case 'call_end':
                case 'end_call':
                    if (currentUsername) endUserCall(currentUsername);
                    break;
            }
        } catch (err) {
            sendError(ws, err.message || 'Erro interno.');
        }
    });

    ws.on('close', () => {
        if (currentUsername) {
            const session = activeSockets.get(currentUsername);
            
            // FIX #1.1: Validação rigorosa antes de remover - verifica se é o socket correto
            if (session && session.ws === ws && session.sessionId) {
                console.log(`[SOCKET CLOSE] Removendo sessão ${session.sessionId} do usuário ${currentUsername}`);
                
                updateLastSeenDebounced(currentUsername).catch(() => {});
                endUserCall(currentUsername);
                activeSockets.delete(currentUsername);
                broadcastUserList().catch(() => {});
            }
        }
    });
});

// ============================================================
// START (assíncrono – espera o schema do Turso)
// ============================================================

async function startServer() {
    try {
        console.log('[START] Inicializando banco Turso...');
        await initDb();

        // Carrega o estado de manutenção só depois das tabelas existirem
        try {
            const row = await stmtGetSetting.get('maintenance');
            if (row && row.value) {
                maintenanceState = JSON.parse(row.value);
            }
        } catch (e) {
            console.warn('[START] Não foi possível carregar maintenance (usando padrão):', e.message);
        }

        server.listen(PORT, () => {
            console.log('ZapZap na porta ' + PORT);
            console.log('[ADMIN] ' + (ADMIN_PASSWORD ? 'Painel administrativo ativado.' : 'ADMIN_PASSWORD nao configurada.'));
            console.log('[DB] ' + dbPath);
        });
    } catch (err) {
        console.error('[START] Falha crítica ao inicializar o servidor:', err);
        process.exit(1);
    }
}

startServer();
