const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const crypto = require('crypto');
const auth = require('./auth');
const db = require('./db');

const PORT = process.env.PORT || 3000;
const clients = new Map(); // ws -> userData

// HTTP Server
const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/admin') {
        const cookies = req.headers.cookie || '';
        const sessionToken = cookies.split('; ').find(row => row.startsWith('admin_session='))?.split('=')[1];
        
        if (!auth.validateAdminSession(sessionToken)) {
            res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
            return res.end('<h1>Acesso Negado</h1><p>Sessão inválida ou expirada.</p>');
        }

        const adminPath = path.join(__dirname, 'admin.html');
        if (fs.existsSync(adminPath)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            return fs.createReadStream(adminPath).pipe(res);
        } else {
            res.writeHead(404);
            return res.end('Painel administrativo não encontrado.');
        }
    }

    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Servidor ZapZap rodando com sucesso.');
});

// WebSocket Server
const wss = new WebSocket.Server({ server });

function broadcast(data, filterFn = null) {
    const payload = JSON.stringify(data);
    for (const [ws, client] of clients.entries()) {
        if (ws.readyState === WebSocket.OPEN) {
            if (!filterFn || filterFn(client)) {
                ws.send(payload);
            }
        }
    }
}

wss.on('connection', (ws) => {
    ws.isAlive = true;

    ws.on('pong', () => {
        ws.isAlive = true;
    });

    ws.on('message', (messageRaw) => {
        try {
            const data = JSON.parse(messageRaw);
            const user = clients.get(ws);

            // AUTO-AUTENTICAÇÃO / LOGIN INICIAL
            if (data.type === 'auth') {
                const authenticatedUser = auth.authenticateSocket(data.username, data.password);
                if (!authenticatedUser) {
                    ws.send(JSON.stringify({ type: 'error', message: 'Credenciais inválidas.' }));
                    return ws.close();
                }

                // Checagem de Modo Manutenção
                const maintenance = db.getMaintenanceMode();
                const isAdminOrCreator = ['Admin', 'Criador'].includes(authenticatedUser.role);

                if (maintenance.active && !isAdminOrCreator) {
                    ws.send(JSON.stringify({
                        type: 'maintenance_block',
                        message: maintenance.message || 'O servidor está em manutenção no momento.'
                    }));
                    return ws.close();
                }

                clients.set(ws, authenticatedUser);
                ws.send(JSON.stringify({
                    type: 'auth_success',
                    user: {
                        username: authenticatedUser.username,
                        role: authenticatedUser.role,
                        avatar: authenticatedUser.avatar,
                        bio: authenticatedUser.bio
                    },
                    maintenance
                }));

                // Envia recados ativos ao conectar
                const announcements = db.stmtGetActiveAnnouncements.all();
                ws.send(JSON.stringify({ type: 'announcements_list', announcements }));
                return;
            }

            // Exige autenticação para todos os outros comandos
            if (!user) {
                ws.send(JSON.stringify({ type: 'error', message: 'Não autenticado.' }));
                return ws.close();
            }

            // MANUTENÇÃO - BLOQUEIO DE AÇÕES DE MEMBROS SE ATIVO
            const maintenance = db.getMaintenanceMode();
            const isAdmin = ['Admin', 'Criador'].includes(user.role);
            if (maintenance.active && !isAdmin) {
                return ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Ações bloqueadas: O servidor está em modo de manutenção.'
                }));
            }

            // ============================================================
            // EVENTOS DE RECADOS (ANNOUNCEMENTS)
            // ============================================================
            if (data.type === 'get_announcements') {
                const list = isAdmin
                    ? db.stmtGetAllAnnouncements.all()
                    : db.stmtGetActiveAnnouncements.all();
                ws.send(JSON.stringify({ type: 'announcements_list', announcements: list }));
            }

            else if (data.type === 'create_announcement') {
                if (!isAdmin) return;
                const msg = String(data.message || '').trim();
                if (!msg) return;

                const res = db.stmtInsertAnnouncement.run(msg, Date.now(), user.username);
                const newAnnouncement = {
                    id: res.lastInsertRowid,
                    message: msg,
                    createdAt: Date.now(),
                    createdBy: user.username,
                    active: 1
                };

                broadcast({ type: 'new_announcement', announcement: newAnnouncement });
            }

            else if (data.type === 'deactivate_announcement') {
                if (!isAdmin) return;
                db.stmtDeactivateAnnouncement.run(data.id);
                broadcast({ type: 'announcement_deactivated', id: data.id });
            }

            else if (data.type === 'delete_announcement') {
                if (!isAdmin) return;
                db.stmtDeleteAnnouncement.run(data.id);
                broadcast({ type: 'announcement_deleted', id: data.id });
            }

            // ============================================================
            // EVENTOS DE MANUTENÇÃO
            // ============================================================
            else if (data.type === 'get_maintenance') {
                ws.send(JSON.stringify({ type: 'maintenance_status', maintenance }));
            }

            else if (data.type === 'set_maintenance') {
                if (!isAdmin) return;
                const updated = db.setMaintenanceMode(data.active, data.message);
                
                broadcast({ type: 'maintenance_status', maintenance: updated });

                // Se ativou manutenção, desconecta usuários normais conectados
                if (updated.active) {
                    for (const [clientWs, clientUser] of clients.entries()) {
                        if (!['Admin', 'Criador'].includes(clientUser.role)) {
                            clientWs.send(JSON.stringify({
                                type: 'maintenance_block',
                                message: updated.message || 'Servidor entrou em manutenção.'
                            }));
                            clientWs.close();
                        }
                    }
                }
            }

            // ============================================================
            // MENSAGENS E SINALIZAÇÃO WEBRTC TRADICIONAL
            // ============================================================
            else if (data.type === 'chat_message') {
                const msgId = crypto.randomUUID();
                const timestamp = Date.now();
                db.stmtInsertMessage.run(
                    msgId, user.username, data.recipient || null,
                    data.content, timestamp, data.msgType || 'text',
                    data.fileUrl || null, data.fileName || null, data.fileSize || null
                );

                const payload = {
                    id: msgId,
                    sender: user.username,
                    recipient: data.recipient,
                    content: data.content,
                    timestamp,
                    msgType: data.msgType || 'text'
                };

                if (data.recipient) {
                    broadcast(payload, u => u.username === data.recipient || u.username === user.username);
                } else {
                    broadcast(payload);
                }
            }

        } catch (err) {
            console.error('[WS Error]', err);
        }
    });

    ws.on('close', () => {
        clients.delete(ws);
    });
});

// Ping/Pong Interval (Heartbeat)
setInterval(() => {
    wss.clients.forEach((ws) => {
        if (!ws.isAlive) return ws.terminate();
        ws.isAlive = false;
        ws.ping();
    });
}, 30000);

server.listen(PORT, () => {
    console.log(`[ZapZap Server] Rodando na porta ${PORT}`);
});
