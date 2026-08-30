const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const {
    WebSocketServer,
    WebSocket
} = require('ws');

const {
    authenticateUser,
    registerUser
} = require('./auth');

const {
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

    db,
    dbPath,
    createDatabaseBackup,
    restoreDatabase
} = require('./db');

const PORT =
    process.env.PORT || 8080;

const RENDER_URL =
    process.env.RENDER_EXTERNAL_URL;

const ADMIN_PASSWORD =
    process.env.ADMIN_PASSWORD || '';

const MAX_MEDIA_BASE64 =
    2.8 * 1024 * 1024;

const MAX_ADMIN_BODY =
    110 * 1024 * 1024;

const ADMIN_SESSION_TIME =
    24 * 60 * 60 * 1000;

const ADMIN_HTML_PATH =
    path.join(__dirname, 'admin.html');

const activeSockets =
    new Map();

const adminSessions =
    new Map();

// ============================================================
// HELPERS HTTP
// ============================================================

function sendJson(res, status, data) {
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store'
    });

    res.end(
        JSON.stringify(data)
    );
}

function sendText(res, status, text) {
    res.writeHead(status, {
        'Content-Type':
            'text/plain; charset=utf-8'
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
                reject(
                    new Error(
                        'Requisicao muito grande.'
                    )
                );

                req.destroy();
                return;
            }

            chunks.push(chunk);
        });

        req.on('end', () => {
            resolve(
                Buffer.concat(chunks)
            );
        });

        req.on('error', reject);
    });
}

function getCookies(req) {
    const header =
        req.headers.cookie || '';

    const cookies = {};

    for (const part of header.split(';')) {
        const index =
            part.indexOf('=');

        if (index === -1) continue;

        const key =
            part.slice(0, index).trim();

        const value =
            part.slice(index + 1).trim();

        cookies[key] =
            decodeURIComponent(value);
    }

    return cookies;
}

function isAdminSession(req) {
    const cookies =
        getCookies(req);

    const token =
        cookies.zapzap_admin;

    if (!token) {
        return false;
    }

    const session =
        adminSessions.get(token);

    if (!session) {
        return false;
    }

    if (
        session.expiresAt <
        Date.now()
    ) {
        adminSessions.delete(token);
        return false;
    }

    return true;
}

function createAdminSession() {
    const token =
        crypto.randomBytes(32)
            .toString('hex');

    adminSessions.set(token, {
        createdAt: Date.now(),
        expiresAt:
            Date.now() +
            ADMIN_SESSION_TIME
    });

    return token;
}

function timingSafePasswordCheck(password) {
    if (!ADMIN_PASSWORD) {
        return false;
    }

    const a =
        crypto
            .createHash('sha256')
            .update(String(password))
            .digest();

    const b =
        crypto
            .createHash('sha256')
            .update(String(ADMIN_PASSWORD))
            .digest();

    return crypto.timingSafeEqual(a, b);
}

function requireAdmin(req, res) {
    if (!isAdminSession(req)) {
        sendJson(res, 401, {
            error: 'Nao autorizado.'
        });

        return false;
    }

    return true;
}

function closeUserSocket(username, reason) {
    const session =
        activeSockets.get(username);

    if (!session) {
        return;
    }

    send(session.ws, {
        type: 'auth_error',
        message: reason
    });

    try {
        session.ws.close();
    } catch {}
}

function parseJsonBody(buffer) {
    try {
        return JSON.parse(
            buffer.toString('utf8')
        );
    } catch {
        throw new Error(
            'JSON invalido.'
        );
    }
}

// ============================================================
// ADMIN HTTP API
// ============================================================

async function handleAdminRequest(
    req,
    res,
    pathname
) {
    // ----------------------------------------
    // LOGIN
    // ----------------------------------------

    if (
        pathname === '/admin/api/login' &&
        req.method === 'POST'
    ) {
        if (!ADMIN_PASSWORD) {
            return sendJson(res, 503, {
                error:
                    'ADMIN_PASSWORD nao configurada no servidor.'
            });
        }

        try {
            const body =
                parseJsonBody(
                    await readBody(
                        req,
                        32 * 1024
                    )
                );

            if (
                !timingSafePasswordCheck(
                    body.password
                )
            ) {
                return sendJson(res, 401, {
                    error:
                        'Senha administrativa incorreta.'
                });
            }

            const token =
                createAdminSession();

            const secure =
                req.headers['x-forwarded-proto'] === 'https'
                    ? '; Secure'
                    : '';

            res.writeHead(200, {
                'Content-Type':
                    'application/json; charset=utf-8',
                'Cache-Control':
                    'no-store',
                'Set-Cookie':
                    `zapzap_admin=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=${Math.floor(ADMIN_SESSION_TIME / 1000)}${secure}`
            });

            return res.end(
                JSON.stringify({
                    success: true
                })
            );

        } catch (err) {
            return sendJson(
                res,
                400,
                {
                    error: err.message
                }
            );
        }
    }

    // ----------------------------------------
    // LOGOUT
    // ----------------------------------------

    if (
        pathname === '/admin/api/logout' &&
        req.method === 'POST'
    ) {
        const cookies =
            getCookies(req);

        if (cookies.zapzap_admin) {
            adminSessions.delete(
                cookies.zapzap_admin
            );
        }

        res.writeHead(200, {
            'Content-Type':
                'application/json',
            'Set-Cookie':
                'zapzap_admin=; HttpOnly; SameSite=Strict; Path=/admin; Max-Age=0'
        });

        return res.end(
            JSON.stringify({
                success: true
            })
        );
    }

    // ----------------------------------------
    // PROTECAO
    // ----------------------------------------

    if (
        pathname.startsWith(
            '/admin/api/'
        )
    ) {
        if (
            !requireAdmin(req, res)
        ) {
            return;
        }
    }

    // ----------------------------------------
    // STATUS
    // ----------------------------------------

    if (
        pathname === '/admin/api/status' &&
        req.method === 'GET'
    ) {
        const users =
            stmtGetAdminUsers.all();

        return sendJson(res, 200, {
            success: true,
            users,
            onlineUsers:
                activeSockets.size,
            uptime:
                Math.floor(
                    process.uptime()
                ),
            database:
                dbPath
        });
    }

    // ----------------------------------------
    // ALTERAR MODERACAO
    // ----------------------------------------

    if (
        pathname ===
            '/admin/api/user/moderation' &&
        req.method === 'POST'
    ) {
        try {
            const body =
                parseJsonBody(
                    await readBody(
                        req,
                        32 * 1024
                    )
                );

            const username =
                String(
                    body.username || ''
                )
                .toLowerCase()
                .trim();

            if (!username) {
                return sendJson(
                    res,
                    400,
                    {
                        error:
                            'Usuario obrigatorio.'
                    }
                );
            }

            const user =
                stmtGetUser.get(
                    username
                );

            if (!user) {
                return sendJson(
                    res,
                    404,
                    {
                        error:
                            'Usuario nao encontrado.'
                    }
                );
            }

            // Nao permite banir o Criador
            if (
                user.role === 'Criador'
            ) {
                return sendJson(
                    res,
                    403,
                    {
                        error:
                            'O Criador nao pode ser moderado por este painel.'
                    }
                );
            }

            const banned =
                body.banned ? 1 : 0;

            let restrictedUntil =
                Number(
                    body.restrictedUntil
                ) || 0;

            if (
                restrictedUntil <
                Date.now()
            ) {
                restrictedUntil = 0;
            }

            stmtSetUserModeration.run(
                banned,
                restrictedUntil,
                username
            );

            if (banned) {
                closeUserSocket(
                    username,
                    'Sua conta foi banida.'
                );
            }

            return sendJson(
                res,
                200,
                {
                    success: true,
                    username,
                    banned: !!banned,
                    restrictedUntil
                }
            );

        } catch (err) {
            return sendJson(
                res,
                400,
                {
                    error:
                        err.message
                }
            );
        }
    }

    // ----------------------------------------
    // ALTERAR NOME / AVATAR
    // ----------------------------------------

    if (
        pathname ===
            '/admin/api/user/profile' &&
        req.method === 'POST'
    ) {
        try {
            const body =
                parseJsonBody(
                    await readBody(
                        req,
                        600 * 1024
                    )
                );

            const username =
                String(
                    body.username || ''
                )
                .toLowerCase()
                .trim();

            const displayName =
                String(
                    body.displayName || ''
                )
                .trim()
                .slice(0, 30);

            const avatar =
                String(
                    body.avatar || ''
                );

            if (!username) {
                return sendJson(
                    res,
                    400,
                    {
                        error:
                            'Usuario obrigatorio.'
                    }
                );
            }

            if (!displayName) {
                return sendJson(
                    res,
                    400,
                    {
                        error:
                            'Nome de exibicao obrigatorio.'
                    }
                );
            }

            if (
                avatar.length >
                400 * 1024
            ) {
                return sendJson(
                    res,
                    400,
                    {
                        error:
                            'Avatar muito grande.'
                    }
                );
            }

            const result =
                stmtAdminUpdateUser.run(
                    displayName,
                    avatar,
                    username
                );

            if (!result.changes) {
                return sendJson(
                    res,
                    404,
                    {
                        error:
                            'Usuario nao encontrado.'
                    }
                );
            }

            const session =
                activeSockets.get(
                    username
                );

            if (session) {
                session.displayName =
                    displayName;

                send(session.ws, {
                    type:
                        'profile_updated',
                    user: {
                        username,
                        displayName,
                        avatar
                    }
                });
            }

            broadcastUserList();

            return sendJson(
                res,
                200,
                {
                    success: true
                }
            );

        } catch (err) {
            return sendJson(
                res,
                400,
                {
                    error:
                        err.message
                }
            );
        }
    }

    // ----------------------------------------
    // BACKUP
    // ----------------------------------------

    if (
        pathname ===
            '/admin/api/backup' &&
        req.method === 'GET'
    ) {
        const backupPath =
            path.join(
                os.tmpdir(),
                `zapzap-backup-${Date.now()}.db`
            );

        try {
            await createDatabaseBackup(
                backupPath
            );

            const stat =
                fs.statSync(
                    backupPath
                );

            res.writeHead(200, {
                'Content-Type':
                    'application/x-sqlite3',
                'Content-Length':
                    stat.size,
                'Content-Disposition':
                    'attachment; filename="zapzap_backup.db"',
                'Cache-Control':
                    'no-store'
            });

            const stream =
                fs.createReadStream(
                    backupPath
                );

            stream.pipe(res);

            stream.on(
                'close',
                () => {
                    try {
                        fs.unlinkSync(
                            backupPath
                        );
                    } catch {}
                }
            );

            stream.on(
                'error',
                () => {
                    try {
                        fs.unlinkSync(
                            backupPath
                        );
                    } catch {}
                }
            );

            return;
        } catch (err) {
            try {
                if (
                    fs.existsSync(
                        backupPath
                    )
                ) {
                    fs.unlinkSync(
                        backupPath
                    );
                }
            } catch {}

            return sendJson(
                res,
                500,
                {
                    error:
                        'Falha ao criar backup: ' +
                        err.message
                }
            );
        }
    }

    // ----------------------------------------
    // RESTORE
    // ----------------------------------------

    if (
        pathname ===
            '/admin/api/restore' &&
        req.method === 'POST'
    ) {
        const tempPath =
            path.join(
                os.tmpdir(),
                `zapzap-restore-${Date.now()}.db`
            );

        try {
            const body =
                await readBody(
                    req,
                    MAX_ADMIN_BODY
                );

            if (
                body.length < 100
            ) {
                return sendJson(
                    res,
                    400,
                    {
                        error:
                            'Arquivo de backup invalido.'
                    }
                );
            }

            fs.writeFileSync(
                tempPath,
                body
            );

            // Valida antes de restaurar
            const testDb =
                new (
                    require('better-sqlite3')
                )(
                    tempPath,
                    {
                        readonly: true,
                        fileMustExist: true
                    }
                );

            const valid =
                testDb.prepare(`
                    SELECT count(*) AS count
                    FROM sqlite_master
                    WHERE type = 'table'
                    AND name IN ('users', 'messages')
                `).get().count >= 2;

            testDb.close();

            if (!valid) {
                throw new Error(
                    'Backup nao pertence ao ZapZap.'
                );
            }

            // Fecha conexoes websocket antes
            // da restauracao para nao deixar
            // sessoes antigas usando dados velhos.
            for (
                const [username, session]
                of activeSockets
            ) {
                send(
                    session.ws,
                    {
                        type:
                            'server_restore',
                        message:
                            'Servidor restaurando o banco. Reconecte.'
                    }
                );

                try {
                    session.ws.close();
                } catch {}

                activeSockets.delete(
                    username
                );
            }

            await restoreDatabase(
                tempPath
            );

            broadcastUserList();

            return sendJson(
                res,
                200,
                {
                    success: true,
                    message:
                        'Banco restaurado com sucesso. Os usuarios devem reconectar.'
                }
            );

        } catch (err) {
            return sendJson(
                res,
                500,
                {
                    error:
                        'Falha ao restaurar: ' +
                        err.message
                }
            );

        } finally {
            try {
                if (
                    fs.existsSync(
                        tempPath
                    )
                ) {
                    fs.unlinkSync(
                        tempPath
                    );
                }
            } catch {}
        }
    }

    return sendJson(
        res,
        404,
        {
            error:
                'Endpoint administrativo nao encontrado.'
        }
    );
}

// ============================================================
// HTTP SERVER
// ============================================================

const server =
    http.createServer(
        async (req, res) => {

            const url =
                new URL(
                    req.url,
                    `http://${req.headers.host || 'localhost'}`
                );

            const pathname =
                url.pathname;

            // ----------------------------
            // ADMIN PAGE
            // ----------------------------

            if (
                pathname === '/admin' ||
                pathname === '/admin/'
            ) {
                if (
                    !fs.existsSync(
                        ADMIN_HTML_PATH
                    )
                ) {
                    return sendText(
                        res,
                        500,
                        'admin.html nao encontrado.'
                    );
                }

                res.writeHead(200, {
                    'Content-Type':
                        'text/html; charset=utf-8',
                    'Cache-Control':
                        'no-store'
                });

                return res.end(
                    fs.readFileSync(
                        ADMIN_HTML_PATH
                    )
                );
            }

            // ----------------------------
            // ADMIN API
            // ----------------------------

            if (
                pathname.startsWith(
                    '/admin/api/'
                )
            ) {
                return handleAdminRequest(
                    req,
                    res,
                    pathname
                );
            }

            // ----------------------------
            // PING
            // ----------------------------

            if (
                pathname === '/ping'
            ) {
                res.writeHead(
                    200,
                    {
                        'Content-Type':
                            'text/plain'
                    }
                );

                return res.end(
                    'pong'
                );
            }

            // ----------------------------
            // HEALTH
            // ----------------------------

            if (
                pathname === '/health'
            ) {
                res.writeHead(
                    200,
                    {
                        'Content-Type':
                            'application/json'
                    }
                );

                return res.end(
                    JSON.stringify({
                        status: 'OK',
                        onlineUsers:
                            activeSockets.size,
                        uptime:
                            Math.floor(
                                process.uptime()
                            )
                    })
                );
            }

            res.writeHead(
                200,
                {
                    'Content-Type':
                        'text/plain; charset=utf-8'
                }
            );

            res.end(
                'Servidor ZapZap'
            );
        }
    );

server.keepAliveTimeout =
    65000;

server.headersTimeout =
    66000;

// ============================================================
// KEEP ALIVE RENDER
// ============================================================

if (RENDER_URL) {
    setInterval(
        async () => {
            try {
                await fetch(
                    RENDER_URL +
                    '/ping'
                );
            } catch {}
        },
        10 * 60 * 1000
    );
}

// ============================================================
// WEBSOCKET
// ============================================================

const wss =
    new WebSocketServer({
        server
    });

const pingInterval =
    setInterval(
        () => {
            wss.clients.forEach(
                ws => {
                    if (
                        ws.isAlive === false
                    ) {
                        return ws.terminate();
                    }

                    ws.isAlive = false;
                    ws.ping();
                }
            );
        },
        30000
    );

wss.on(
    'close',
    () =>
        clearInterval(
            pingInterval
        )
);

function send(ws, payload) {
    if (
        ws &&
        ws.readyState === WebSocket.OPEN
    ) {
        ws.send(
            JSON.stringify(
                payload
            )
        );
    }
}

function sendError(
    ws,
    message
) {
    send(ws, {
        type: 'auth_error',
        message
    });
}

function getUsersData() {
    try {
        return stmtGetAllUsers
            .all()
            .map(u => ({
                username:
                    u.username,
                displayName:
                    u.displayName,
                avatar:
                    u.avatar,
                role:
                    u.role,
                bio:
                    u.bio || '',
                online:
                    activeSockets.has(
                        u.username
                    )
            }));
    } catch {
        return [];
    }
}

function broadcastUserList() {
    const users =
        getUsersData();

    for (
        const { ws }
        of activeSockets.values()
    ) {
        send(ws, {
            type: 'users_list',
            users
        });

        send(ws, {
            type: 'contacts_list',
            users
        });
    }
}

function endUserCall(
    username
) {
    const session =
        activeSockets.get(
            username
        );

    if (!session) {
        return;
    }

    const target =
        session.callTarget;

    session.isBusy = false;
    session.callTarget = null;

    if (target) {
        const t =
            activeSockets.get(
                target
            );

        if (t) {
            t.isBusy = false;
            t.callTarget = null;

            send(t.ws, {
                type:
                    'call_ended',
                from:
                    username
            });
        }
    }
}

function isDeletedForUser(
    msg,
    username
) {
    if (
        msg.deleted_for_all
    ) {
        return true;
    }

    if (!msg.deleted_for) {
        return false;
    }

    return msg.deleted_for
        .split(',')
        .includes(username);
}

function getCurrentUserStatus(
    username
) {
    const user =
        stmtGetUser.get(
            username
        );

    if (!user) {
        return {
            exists: false,
            banned: false,
            restrictedUntil: 0,
            restricted: false
        };
    }

    const restrictedUntil =
        Number(
            user.restrictedUntil
        ) || 0;

    return {
        exists: true,
        banned:
            !!user.banned,
        restrictedUntil,
        restricted:
            restrictedUntil >
            Date.now()
    };
}

function checkRestricted(
    ws,
    username
) {
    const status =
        getCurrentUserStatus(
            username
        );

    if (!status.exists) {
        sendError(
            ws,
            'Conta nao encontrada.'
        );

        return true;
    }

    if (status.banned) {
        sendError(
            ws,
            'Sua conta foi banida.'
        );

        try {
            ws.close();
        } catch {}

        return true;
    }

    if (status.restricted) {
        send(ws, {
            type:
                'account_restricted',
            restrictedUntil:
                status.restrictedUntil,
            message:
                'Sua conta esta temporariamente restrita.'
        });

        return true;
    }

    return false;
}

// ============================================================
// WEBSOCKET CONNECTION
// ============================================================

wss.on(
    'connection',
    ws => {

        ws.isAlive = true;

        ws.on(
            'pong',
            () => {
                ws.isAlive = true;
            }
        );

        let currentUsername =
            null;

        ws.on(
            'message',
            async raw => {

                let data;

                try {
                    data =
                        JSON.parse(
                            raw.toString()
                        );
                } catch {
                    return sendError(
                        ws,
                        'JSON invalido.'
                    );
                }

                try {

                    switch (
                        data.type
                    ) {

                        // --------------------
                        // PING
                        // --------------------

                        case 'ping':
                            ws.isAlive = true;

                            return send(
                                ws,
                                {
                                    type:
                                        'pong'
                                }
                            );

                        // --------------------
                        // LOGIN
                        // --------------------

                        case 'login': {

                            const user =
                                await authenticateUser(
                                    data.username,
                                    data.password
                                );

                            if (
                                activeSockets.has(
                                    user.username
                                )
                            ) {
                                const old =
                                    activeSockets
                                        .get(
                                            user.username
                                        )
                                        .ws;

                                send(
                                    old,
                                    {
                                        type:
                                            'auth_error',
                                        message:
                                            'Nova conexao em outro dispositivo.'
                                    }
                                );

                                old.close();
                            }

                            currentUsername =
                                user.username;

                            activeSockets.set(
                                currentUsername,
                                {
                                    ws,
                                    displayName:
                                        user.displayName,
                                    isBusy:
                                        false,
                                    callTarget:
                                        null
                                }
                            );

                            send(
                                ws,
                                {
                                    type:
                                        'auth_success',

                                    user:
                                        Object.assign(
                                            {},
                                            user,
                                            {
                                                bio:
                                                    user.bio ||
                                                    ''
                                            }
                                        ),

                                    credentials: {
                                        username:
                                            data.username,
                                        password:
                                            data.password
                                    }
                                }
                            );

                            broadcastUserList();

                            break;
                        }

                        // --------------------
                        // REGISTER
                        // --------------------

                        case 'register': {

                            const user =
                                await registerUser(
                                    data.username,
                                    data.password,
                                    data.displayName,
                                    data.avatar
                                );

                            currentUsername =
                                user.username;

                            activeSockets.set(
                                currentUsername,
                                {
                                    ws,
                                    displayName:
                                        user.displayName,
                                    isBusy:
                                        false,
                                    callTarget:
                                        null
                                }
                            );

                            send(
                                ws,
                                {
                                    type:
                                        'auth_success',

                                    user:
                                        Object.assign(
                                            {},
                                            user,
                                            {
                                                bio:
                                                    ''
                                            }
                                        ),

                                    credentials: {
                                        username:
                                            data.username,
                                        password:
                                            data.password
                                    }
                                }
                            );

                            broadcastUserList();

                            break;
                        }

                        // --------------------
                        // PROFILE
                        // --------------------

                        case 'update_profile': {

                            if (
                                !currentUsername
                            ) {
                                return;
                            }

                            if (
                                checkRestricted(
                                    ws,
                                    currentUsername
                                )
                            ) {
                                return;
                            }

                            const displayName =
                                (
                                    data.displayName ||
                                    ''
                                )
                                .trim()
                                .slice(0, 30);

                            const bio =
                                (
                                    data.bio ||
                                    ''
                                )
                                .trim()
                                .slice(0, 200);

                            const avatar =
                                data.avatar ||
                                '';

                            if (
                                !displayName
                            ) {
                                return send(
                                    ws,
                                    {
                                        type:
                                            'profile_error',
                                        message:
                                            'Nome de exibicao obrigatorio.'
                                    }
                                );
                            }

                            stmtUpdateProfile.run(
                                displayName,
                                avatar,
                                bio,
                                currentUsername
                            );

                            const session =
                                activeSockets.get(
                                    currentUsername
                                );

                            if (session) {
                                session.displayName =
                                    displayName;
                            }

                            send(
                                ws,
                                {
                                    type:
                                        'profile_updated',

                                    user: {
                                        username:
                                            currentUsername,
                                        displayName,
                                        avatar,
                                        bio
                                    }
                                }
                            );

                            broadcastUserList();

                            break;
                        }

                        // --------------------
                        // USERS
                        // --------------------

                        case 'get_contacts':
                        case 'get_users':

                            send(
                                ws,
                                {
                                    type:
                                        'contacts_list',
                                    users:
                                        getUsersData()
                                }
                            );

                            break;

                        // --------------------
                        // CHAT
                        // --------------------

                        case 'chat_message': {

                            if (
                                !currentUsername ||
                                !data.to
                            ) {
                                return;
                            }

                            if (
                                checkRestricted(
                                    ws,
                                    currentUsername
                                )
                            ) {
                                return;
                            }

                            const msgType =
                                data.msg_type ||
                                'text';

                            let content =
                                (
                                    data.text ||
                                    ''
                                )
                                .trim();

                            let mediaMeta =
                                null;

                            if (data.media) {

                                if (
                                    typeof data.media !==
                                        'string' ||
                                    data.media.length >
                                        MAX_MEDIA_BASE64
                                ) {
                                    return send(
                                        ws,
                                        {
                                            type:
                                                'chat_error',
                                            message:
                                                'Arquivo muito grande apos compressao.'
                                        }
                                    );
                                }

                                content =
                                    data.media;

                                mediaMeta =
                                    JSON.stringify({
                                        name:
                                            data.fileName ||
                                            'arquivo',

                                        mime:
                                            data.mime ||
                                            'application/octet-stream',

                                        size:
                                            data.media.length,

                                        duration:
                                            data.duration ||
                                            null
                                    });
                            }

                            if (!content) {
                                return;
                            }

                            const timestamp =
                                Date.now();

                            const replyTo =
                                data.reply_to
                                    ? Number(
                                        data.reply_to
                                    )
                                    : null;

                            const info =
                                stmtInsertMessage.run(
                                    currentUsername,
                                    data.to,
                                    content,
                                    timestamp,
                                    msgType,
                                    mediaMeta,
                                    replyTo
                                );

                            let replyPreview =
                                null;

                            if (replyTo) {

                                const orig =
                                    stmtGetMessageById.get(
                                        replyTo
                                    );

                                if (orig) {
                                    replyPreview = {
                                        id:
                                            orig.id,

                                        sender:
                                            orig.sender,

                                        content:
                                            orig.msg_type ===
                                            'text'
                                                ? (
                                                    orig.content ||
                                                    ''
                                                ).slice(
                                                    0,
                                                    80
                                                )
                                                : '[' +
                                                  orig.msg_type +
                                                  ']',

                                        msg_type:
                                            orig.msg_type
                                    };
                                }
                            }

                            const payload = {
                                type:
                                    'chat_message',

                                id:
                                    info.lastInsertRowid,

                                from:
                                    currentUsername,

                                to:
                                    data.to,

                                text:
                                    msgType === 'text'
                                        ? content
                                        : null,

                                media:
                                    msgType !== 'text'
                                        ? content
                                        : null,

                                msg_type:
                                    msgType,

                                media_meta:
                                    mediaMeta
                                        ? JSON.parse(
                                            mediaMeta
                                        )
                                        : null,

                                timestamp,

                                reply_to:
                                    replyTo,

                                reply_preview:
                                    replyPreview,

                                edited:
                                    false
                            };

                            const targetSession =
                                activeSockets.get(
                                    data.to
                                );

                            if (
                                targetSession
                            ) {
                                send(
                                    targetSession.ws,
                                    payload
                                );
                            }

                            send(
                                ws,
                                Object.assign(
                                    {},
                                    payload,
                                    {
                                        confirmed:
                                            true
                                    }
                                )
                            );

                            break;
                        }

                        // --------------------
                        // EDIT
                        // --------------------

                        case 'edit_message': {

                            if (
                                !currentUsername ||
                                !data.messageId ||
                                !data.text
                            ) {
                                return;
                            }

                            if (
                                checkRestricted(
                                    ws,
                                    currentUsername
                                )
                            ) {
                                return;
                            }

                            const text =
                                String(
                                    data.text
                                )
                                .trim()
                                .slice(0, 2000);

                            if (!text) {
                                return;
                            }

                            const result =
                                stmtEditMessage.run(
                                    text,
                                    data.messageId,
                                    currentUsername,
                                    Date.now()
                                );

                            if (
                                result.changes >
                                0
                            ) {
                                const payload = {
                                    type:
                                        'message_edited',

                                    messageId:
                                        data.messageId,

                                    text,

                                    by:
                                        currentUsername
                                };

                                send(
                                    ws,
                                    payload
                                );

                                if (
                                    data.withUser
                                ) {
                                    const t =
                                        activeSockets.get(
                                            data.withUser
                                        );

                                    if (t) {
                                        send(
                                            t.ws,
                                            payload
                                        );
                                    }
                                }
                            } else {
                                send(
                                    ws,
                                    {
                                        type:
                                            'chat_error',
                                        message:
                                            'Nao foi possivel editar (limite 5 min ou nao e sua).'
                                    }
                                );
                            }

                            break;
                        }

                        // --------------------
                        // HISTORY
                        // --------------------

                        case 'get_chat_history': {

                            if (
                                !currentUsername ||
                                !data.withUser
                            ) {
                                return;
                            }

                            const history =
                                stmtGetChatHistory.all(
                                    currentUsername,
                                    data.withUser,
                                    data.withUser,
                                    currentUsername
                                );

                            const filtered =
                                history
                                    .filter(
                                        m =>
                                            !isDeletedForUser(
                                                m,
                                                currentUsername
                                            )
                                    )
                                    .map(
                                        m => {

                                            let reply_preview =
                                                null;

                                            if (
                                                m.reply_to
                                            ) {
                                                const orig =
                                                    stmtGetMessageById.get(
                                                        m.reply_to
                                                    );

                                                if (orig) {
                                                    reply_preview = {
                                                        id:
                                                            orig.id,

                                                        sender:
                                                            orig.sender,

                                                        content:
                                                            orig.msg_type ===
                                                            'text'
                                                                ? (
                                                                    orig.content ||
                                                                    ''
                                                                ).slice(
                                                                    0,
                                                                    80
                                                                )
                                                                : '[' +
                                                                  orig.msg_type +
                                                                  ']',

                                                        msg_type:
                                                            orig.msg_type
                                                    };
                                                }
                                            }

                                            return {
                                                id:
                                                    m.id,

                                                sender:
                                                    m.sender,

                                                content:
                                                    m.deleted_for_all
                                                        ? null
                                                        : m.content,

                                                timestamp:
                                                    m.timestamp,

                                                msg_type:
                                                    m.msg_type ||
                                                    'text',

                                                media_meta:
                                                    m.media_meta
                                                        ? JSON.parse(
                                                            m.media_meta
                                                        )
                                                        : null,

                                                deleted_for_all:
                                                    !!m.deleted_for_all,

                                                reply_to:
                                                    m.reply_to,

                                                reply_preview,

                                                edited:
                                                    !!m.edited
                                            };
                                        }
                                    );

                            send(
                                ws,
                                {
                                    type:
                                        'chat_history',

                                    withUser:
                                        data.withUser,

                                    messages:
                                        filtered
                                }
                            );

                            break;
                        }

                        // --------------------
                        // DELETE MESSAGE
                        // --------------------

                        case 'delete_message': {

                            if (
                                !currentUsername ||
                                !data.messageId
                            ) {
                                return;
                            }

                            if (
                                checkRestricted(
                                    ws,
                                    currentUsername
                                )
                            ) {
                                return;
                            }

                            const forAll =
                                !!data.forAll;

                            if (forAll) {

                                const r =
                                    stmtDeleteForAll.run(
                                        data.messageId,
                                        currentUsername
                                    );

                                if (
                                    r.changes > 0
                                ) {
                                    const payload = {
                                        type:
                                            'message_deleted',

                                        messageId:
                                            data.messageId,

                                        forAll:
                                            true,

                                        by:
                                            currentUsername
                                    };

                                    send(
                                        ws,
                                        payload
                                    );

                                    if (
                                        data.withUser
                                    ) {
                                        const t =
                                            activeSockets.get(
                                                data.withUser
                                            );

                                        if (t) {
                                            send(
                                                t.ws,
                                                payload
                                            );
                                        }
                                    }
                                }

                            } else {

                                stmtSoftDeleteForUser.run(
                                    currentUsername,
                                    currentUsername,
                                    currentUsername,
                                    data.messageId
                                );

                                send(
                                    ws,
                                    {
                                        type:
                                            'message_deleted',

                                        messageId:
                                            data.messageId,

                                        forAll:
                                            false,

                                        by:
                                            currentUsername
                                    }
                                );
                            }

                            break;
                        }

                        // --------------------
                        // DELETE CONVERSATION
                        // --------------------

                        case 'delete_conversation': {

                            if (
                                !currentUsername ||
                                !data.withUser
                            ) {
                                return;
                            }

                            if (
                                checkRestricted(
                                    ws,
                                    currentUsername
                                )
                            ) {
                                return;
                            }

                            const forAll =
                                !!data.forAll;

                            if (forAll) {

                                stmtDeleteConversationForAll.run(
                                    currentUsername,
                                    data.withUser,
                                    data.withUser,
                                    currentUsername,
                                    currentUsername
                                );

                                const payload = {
                                    type:
                                        'conversation_deleted',

                                    withUser:
                                        data.withUser,

                                    forAll:
                                        true,

                                    by:
                                        currentUsername
                                };

                                send(
                                    ws,
                                    payload
                                );

                                const t =
                                    activeSockets.get(
                                        data.withUser
                                    );

                                if (t) {
                                    send(
                                        t.ws,
                                        payload
                                    );
                                }

                            } else {

                                stmtDeleteConversationForUser.run(
                                    currentUsername,
                                    currentUsername,
                                    currentUsername,
                                    currentUsername,
                                    data.withUser,
                                    data.withUser,
                                    currentUsername
                                );

                                send(
                                    ws,
                                    {
                                        type:
                                            'conversation_deleted',

                                        withUser:
                                            data.withUser,

                                        forAll:
                                            false,

                                        by:
                                            currentUsername
                                    }
                                );
                            }

                            break;
                        }

                        // --------------------
                        // CALL
                        // --------------------

                        case 'call_initiate': {

                            if (
                                !currentUsername
                            ) {
                                return;
                            }

                            if (
                                checkRestricted(
                                    ws,
                                    currentUsername
                                )
                            ) {
                                return;
                            }

                            const callee =
                                activeSockets.get(
                                    data.callee
                                );

                            const caller =
                                activeSockets.get(
                                    currentUsername
                                );

                            if (!callee) {
                                return send(
                                    ws,
                                    {
                                        type:
                                            'call_offline',
                                        callee:
                                            data.callee
                                    }
                                );
                            }

                            if (
                                callee.isBusy
                            ) {
                                return send(
                                    ws,
                                    {
                                        type:
                                            'call_error',
                                        message:
                                            'Usuario ocupado.'
                                    }
                                );
                            }

                            caller.isBusy =
                                true;

                            caller.callTarget =
                                data.callee;

                            send(
                                callee.ws,
                                {
                                    type:
                                        'call_incoming',

                                    caller:
                                        currentUsername,

                                    callerDisplayName:
                                        caller.displayName,

                                    offer:
                                        data.offer
                                }
                            );

                            break;
                        }

                        case 'call_answer': {

                            if (
                                !currentUsername
                            ) {
                                return;
                            }

                            if (
                                checkRestricted(
                                    ws,
                                    currentUsername
                                )
                            ) {
                                return;
                            }

                            const caller =
                                activeSockets.get(
                                    data.caller
                                );

                            const answerer =
                                activeSockets.get(
                                    currentUsername
                                );

                            if (answerer) {
                                answerer.isBusy =
                                    true;

                                answerer.callTarget =
                                    data.caller;
                            }

                            if (caller) {

                                caller.isBusy =
                                    true;

                                caller.callTarget =
                                    currentUsername;

                                send(
                                    caller.ws,
                                    {
                                        type:
                                            'call_answered',

                                        answerer:
                                            currentUsername,

                                        answer:
                                            data.answer
                                    }
                                );
                            }

                            break;
                        }

                        case 'call_reject': {

                            if (
                                !currentUsername
                            ) {
                                return;
                            }

                            const caller =
                                activeSockets.get(
                                    data.caller
                                );

                            if (caller) {

                                caller.isBusy =
                                    false;

                                caller.callTarget =
                                    null;

                                send(
                                    caller.ws,
                                    {
                                        type:
                                            'call_rejected',

                                        from:
                                            currentUsername
                                    }
                                );
                            }

                            break;
                        }

                        case 'call_ice_candidate': {

                            if (
                                !currentUsername
                            ) {
                                return;
                            }

                            const t =
                                activeSockets.get(
                                    data.to
                                );

                            if (t) {
                                send(
                                    t.ws,
                                    {
                                        type:
                                            'call_ice_candidate',

                                        from:
                                            currentUsername,

                                        candidate:
                                            data.candidate
                                    }
                                );
                            }

                            break;
                        }

                        case 'call_end':

                            if (
                                currentUsername
                            ) {
                                endUserCall(
                                    currentUsername
                                );
                            }

                            break;
                    }

                } catch (err) {

                    sendError(
                        ws,
                        err.message ||
                        'Erro interno.'
                    );
                }
            }
        );

        ws.on(
            'close',
            () => {

                if (
                    currentUsername
                ) {

                    endUserCall(
                        currentUsername
                    );

                    activeSockets.delete(
                        currentUsername
                    );

                    broadcastUserList();
                }
            }
        );
    }
);

// ============================================================
// START
// ============================================================

server.listen(
    PORT,
    () => {
        console.log(
            'ZapZap na porta ' +
            PORT
        );

        console.log(
            '[ADMIN] ' +
            (
                ADMIN_PASSWORD
                    ? 'Painel administrativo ativado.'
                    : 'ADMIN_PASSWORD nao configurada.'
            )
        );

        console.log(
            '[DB] ' +
            dbPath
        );
    }
);
