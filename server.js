const http = require('http');
const { WebSocketServer, WebSocket } = require('ws');
const { authenticateUser, registerUser } = require('./auth');
const {
    stmtGetAllUsers, stmtInsertMessage, stmtGetChatHistory, stmtGetMessageById,
    stmtSoftDeleteForUser, stmtDeleteForAll,
    stmtDeleteConversationForUser, stmtDeleteConversationForAll,
    stmtUpdateProfile, stmtEditMessage, dbPath
} = require('./db');

let uploadDatabaseBackup = null;
try { uploadDatabaseBackup = require('./driveBackup').uploadDatabaseBackup; } catch { /* opcional */ }

const PORT = process.env.PORT || 8080;
const RENDER_URL = process.env.RENDER_EXTERNAL_URL;
const MAX_MEDIA_BASE64 = 2.8 * 1024 * 1024;

const activeSockets = new Map();

const server = http.createServer((req, res) => {
    if (req.url === '/ping') {
        res.writeHead(200, { 'Content-Type': 'text/plain' });
        return res.end('pong');
    }
    if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
            status: 'OK',
            onlineUsers: activeSockets.size,
            uptime: Math.floor(process.uptime())
        }));
    }
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Servidor ZapZap');
});

server.keepAliveTimeout = 65000;
server.headersTimeout = 66000;

if (RENDER_URL) {
    setInterval(async () => { try { await fetch(RENDER_URL + '/ping'); } catch {} }, 10 * 60 * 1000);
}
if (typeof uploadDatabaseBackup === 'function') {
    setInterval(() => uploadDatabaseBackup(dbPath), 6 * 60 * 60 * 1000);
}

const wss = new WebSocketServer({ server });
const pingInterval = setInterval(() => {
    wss.clients.forEach((ws) => {
        if (ws.isAlive === false) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);
wss.on('close', () => clearInterval(pingInterval));

function send(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}
function sendError(ws, message) {
    send(ws, { type: 'auth_error', message });
}

function getUsersData() {
    try {
        return stmtGetAllUsers.all().map(u => ({
            username: u.username,
            displayName: u.displayName,
            avatar: u.avatar,
            role: u.role,
            bio: u.bio || '',
            online: activeSockets.has(u.username)
        }));
    } catch { return []; }
}

function broadcastUserList() {
    const users = getUsersData();
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

wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    let currentUsername = null;

    ws.on('message', async (raw) => {
        let data;
        try { data = JSON.parse(raw.toString()); }
        catch { return sendError(ws, 'JSON invalido.'); }

        try {
            switch (data.type) {
                case 'ping':
                    ws.isAlive = true;
                    return send(ws, { type: 'pong' });

                case 'login': {
                    const user = await authenticateUser(data.username, data.password);
                    if (activeSockets.has(user.username)) {
                        const old = activeSockets.get(user.username).ws;
                        send(old, { type: 'auth_error', message: 'Nova conexao em outro dispositivo.' });
                        old.close();
                    }
                    currentUsername = user.username;
                    activeSockets.set(currentUsername, { ws, displayName: user.displayName, isBusy: false, callTarget: null });
                    send(ws, {
                        type: 'auth_success',
                        user: Object.assign({}, user, { bio: user.bio || '' }),
                        credentials: { username: data.username, password: data.password }
                    });
                    broadcastUserList();
                    break;
                }

                case 'register': {
                    const user = await registerUser(data.username, data.password, data.displayName, data.avatar);
                    currentUsername = user.username;
                    activeSockets.set(currentUsername, { ws, displayName: user.displayName, isBusy: false, callTarget: null });
                    send(ws, {
                        type: 'auth_success',
                        user: Object.assign({}, user, { bio: '' }),
                        credentials: { username: data.username, password: data.password }
                    });
                    broadcastUserList();
                    break;
                }

                case 'update_profile': {
                    if (!currentUsername) return;
                    const displayName = (data.displayName || '').trim().slice(0, 30);
                    const bio = (data.bio || '').trim().slice(0, 200);
                    const avatar = data.avatar || '';
                    if (!displayName) return send(ws, { type: 'profile_error', message: 'Nome de exibicao obrigatorio.' });
                    stmtUpdateProfile.run(displayName, avatar, bio, currentUsername);
                    const session = activeSockets.get(currentUsername);
                    if (session) session.displayName = displayName;
                    send(ws, {
                        type: 'profile_updated',
                        user: { username: currentUsername, displayName: displayName, avatar: avatar, bio: bio }
                    });
                    broadcastUserList();
                    break;
                }

                case 'get_contacts':
                case 'get_users':
                    send(ws, { type: 'contacts_list', users: getUsersData() });
                    break;

                case 'chat_message': {
                    if (!currentUsername || !data.to) return;
                    const msgType = data.msg_type || 'text';
                    let content = (data.text || '').trim();
                    let mediaMeta = null;

                    if (data.media) {
                        if (typeof data.media !== 'string' || data.media.length > MAX_MEDIA_BASE64) {
                            return send(ws, { type: 'chat_error', message: 'Arquivo muito grande apos compressao.' });
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
                    const info = stmtInsertMessage.run(
                        currentUsername, data.to, content, timestamp, msgType, mediaMeta, replyTo
                    );

                    let replyPreview = null;
                    if (replyTo) {
                        const orig = stmtGetMessageById.get(replyTo);
                        if (orig) {
                            replyPreview = {
                                id: orig.id,
                                sender: orig.sender,
                                content: orig.msg_type === 'text' ? (orig.content || '').slice(0, 80) : '[' + orig.msg_type + ']',
                                msg_type: orig.msg_type
                            };
                        }
                    }

                    const payload = {
                        type: 'chat_message',
                        id: info.lastInsertRowid,
                        from: currentUsername,
                        to: data.to,
                        text: msgType === 'text' ? content : null,
                        media: msgType !== 'text' ? content : null,
                        msg_type: msgType,
                        media_meta: mediaMeta ? JSON.parse(mediaMeta) : null,
                        timestamp: timestamp,
                        reply_to: replyTo,
                        reply_preview: replyPreview,
                        edited: false
                    };

                    const targetSession = activeSockets.get(data.to);
                    if (targetSession) send(targetSession.ws, payload);
                    send(ws, Object.assign({}, payload, { confirmed: true }));
                    break;
                }

                case 'edit_message': {
                    if (!currentUsername || !data.messageId || !data.text) return;
                    const text = String(data.text).trim().slice(0, 2000);
                    if (!text) return;
                    const result = stmtEditMessage.run(text, data.messageId, currentUsername, Date.now());
                    if (result.changes > 0) {
                        const payload = { type: 'message_edited', messageId: data.messageId, text: text, by: currentUsername };
                        send(ws, payload);
                        if (data.withUser) {
                            const t = activeSockets.get(data.withUser);
                            if (t) send(t.ws, payload);
                        }
                    } else {
                        send(ws, { type: 'chat_error', message: 'Nao foi possivel editar (limite 5 min ou nao e sua).' });
                    }
                    break;
                }

                case 'get_chat_history': {
                    if (!currentUsername || !data.withUser) return;
                    const history = stmtGetChatHistory.all(
                        currentUsername, data.withUser, data.withUser, currentUsername
                    );
                    const filtered = history
                        .filter(m => !isDeletedForUser(m, currentUsername))
                        .map(m => {
                            let reply_preview = null;
                            if (m.reply_to) {
                                const orig = stmtGetMessageById.get(m.reply_to);
                                if (orig) {
                                    reply_preview = {
                                        id: orig.id,
                                        sender: orig.sender,
                                        content: orig.msg_type === 'text' ? (orig.content || '').slice(0, 80) : '[' + orig.msg_type + ']',
                                        msg_type: orig.msg_type
                                    };
                                }
                            }
                            return {
                                id: m.id,
                                sender: m.sender,
                                content: m.deleted_for_all ? null : m.content,
                                timestamp: m.timestamp,
                                msg_type: m.msg_type || 'text',
                                media_meta: m.media_meta ? JSON.parse(m.media_meta) : null,
                                deleted_for_all: !!m.deleted_for_all,
                                reply_to: m.reply_to,
                                reply_preview: reply_preview,
                                edited: !!m.edited
                            };
                        });
                    send(ws, { type: 'chat_history', withUser: data.withUser, messages: filtered });
                    break;
                }

                case 'delete_message': {
                    if (!currentUsername || !data.messageId) return;
                    const forAll = !!data.forAll;
                    if (forAll) {
                        const r = stmtDeleteForAll.run(data.messageId, currentUsername);
                        if (r.changes > 0) {
                            const payload = { type: 'message_deleted', messageId: data.messageId, forAll: true, by: currentUsername };
                            send(ws, payload);
                            if (data.withUser) {
                                const t = activeSockets.get(data.withUser);
                                if (t) send(t.ws, payload);
                            }
                        }
                    } else {
                        stmtSoftDeleteForUser.run(currentUsername, currentUsername, currentUsername, data.messageId);
                        send(ws, { type: 'message_deleted', messageId: data.messageId, forAll: false, by: currentUsername });
                    }
                    break;
                }

                case 'delete_conversation': {
                    if (!currentUsername || !data.withUser) return;
                    const forAll = !!data.forAll;
                    if (forAll) {
                        stmtDeleteConversationForAll.run(
                            currentUsername, data.withUser, data.withUser, currentUsername, currentUsername
                        );
                        const payload = { type: 'conversation_deleted', withUser: data.withUser, forAll: true, by: currentUsername };
                        send(ws, payload);
                        const t = activeSockets.get(data.withUser);
                        if (t) send(t.ws, payload);
                    } else {
                        stmtDeleteConversationForUser.run(
                            currentUsername, currentUsername, currentUsername,
                            currentUsername, data.withUser, data.withUser, currentUsername
                        );
                        send(ws, { type: 'conversation_deleted', withUser: data.withUser, forAll: false, by: currentUsername });
                    }
                    break;
                }

                case 'call_initiate': {
                    if (!currentUsername) return;
                    const callee = activeSockets.get(data.callee);
                    const caller = activeSockets.get(currentUsername);
                    if (!callee) return send(ws, { type: 'call_offline', callee: data.callee });
                    if (callee.isBusy) return send(ws, { type: 'call_error', message: 'Usuario ocupado.' });
                    caller.isBusy = true;
                    caller.callTarget = data.callee;
                    send(callee.ws, {
                        type: 'call_incoming',
                        caller: currentUsername,
                        callerDisplayName: caller.displayName,
                        offer: data.offer
                    });
                    break;
                }
                case 'call_answer': {
                    if (!currentUsername) return;
                    const caller = activeSockets.get(data.caller);
                    const answerer = activeSockets.get(currentUsername);
                    if (answerer) { answerer.isBusy = true; answerer.callTarget = data.caller; }
                    if (caller) {
                        caller.isBusy = true;
                        caller.callTarget = currentUsername;
                        send(caller.ws, { type: 'call_answered', answerer: currentUsername, answer: data.answer });
                    }
                    break;
                }
                case 'call_reject': {
                    if (!currentUsername) return;
                    const caller = activeSockets.get(data.caller);
                    if (caller) {
                        caller.isBusy = false;
                        caller.callTarget = null;
                        send(caller.ws, { type: 'call_rejected', from: currentUsername });
                    }
                    break;
                }
                case 'call_ice_candidate': {
                    if (!currentUsername) return;
                    const t = activeSockets.get(data.to);
                    if (t) send(t.ws, { type: 'call_ice_candidate', from: currentUsername, candidate: data.candidate });
                    break;
                }
                case 'call_end':
                    if (currentUsername) endUserCall(currentUsername);
                    break;
            }
        } catch (err) {
            sendError(ws, err.message || 'Erro interno.');
        }
    });

    ws.on('close', () => {
        if (currentUsername) {
            endUserCall(currentUsername);
            activeSockets.delete(currentUsername);
            broadcastUserList();
        }
    });
});

server.listen(PORT, () => console.log('ZapZap na porta ' + PORT));
