const bcrypt = require('bcryptjs');
const {
    stmtRegister,
    stmtGetUser,
    db,
    invalidateUserCache
} = require('./db');

const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;
const MAX_AVATAR_SIZE = 400 * 1024;

// ============================================================
// SESSION TOKENS PARA RECONEXÃO (FIX #4)
// ============================================================

const sessionTokens = new Map(); // { token -> { username, createdAt, expiresAt } }
const SESSION_TOKEN_TTL = 24 * 60 * 60 * 1000; // 24 horas

class AuthError extends Error {}

function validateCredentials(username, password) {
    const cleanUser = (username || '').toLowerCase().trim();

    if (!USERNAME_REGEX.test(cleanUser)) {
        throw new AuthError(
            'Usuario deve ter entre 3 e 20 caracteres (apenas letras minusculas, numeros e _).'
        );
    }

    if (typeof password !== 'string' || password.length < 6) {
        throw new AuthError('A senha deve ter no minimo 6 caracteres.');
    }

    return cleanUser;
}

function getRestrictionInfo(user) {
    const now = Date.now();

    if (user.banned) {
        throw new AuthError('Esta conta foi banida.');
    }

    const restrictedUntil = Number(user.restrictedUntil) || 0;

    return {
        restricted: restrictedUntil > now,
        restrictedUntil: restrictedUntil > now ? restrictedUntil : 0
    };
}

// ============================================================
// FIX #4.1: GERAÇÃO E VALIDAÇÃO DE SESSION TOKENS
// ============================================================

function generateSessionToken(username) {
    const token = require('crypto').randomBytes(32).toString('hex');
    sessionTokens.set(token, {
        username,
        createdAt: Date.now(),
        expiresAt: Date.now() + SESSION_TOKEN_TTL
    });

    // Limpa tokens expirados periodicamente
    if (sessionTokens.size > 1000) {
        const now = Date.now();
        for (const [t, session] of sessionTokens.entries()) {
            if (session.expiresAt < now) {
                sessionTokens.delete(t);
            }
        }
    }

    return token;
}

function validateSessionToken(token) {
    const session = sessionTokens.get(token);
    if (!session) {
        return null;
    }

    if (session.expiresAt < Date.now()) {
        sessionTokens.delete(token);
        return null;
    }

    return session;
}

// ============================================================
// FIX #4.2: RECONEXÃO COM VALIDAÇÃO DE TOKEN
// ============================================================

async function reconnectWithToken(token) {
    const session = validateSessionToken(token);
    if (!session) {
        throw new AuthError('Sessão expirada ou inválida. Faça login novamente.');
    }

    const user = await stmtGetUser.get(session.username);
    if (!user) {
        sessionTokens.delete(token);
        throw new AuthError('Usuário não encontrado.');
    }

    const restriction = getRestrictionInfo(user);

    return {
        username: user.username,
        displayName: user.displayName,
        avatar: user.avatar,
        role: user.role,
        bio: user.bio || '',
        banned: !!user.banned,
        restricted: restriction.restricted,
        restrictedUntil: restriction.restrictedUntil,
        sessionToken: token // Renova o mesmo token
    };
}

// ============================================================
// REGISTRO DE USUÁRIO
// ============================================================

async function registerUser(username, password, displayName, avatar) {
    const cleanUser = validateCredentials(username, password);

    if (avatar && avatar.length > MAX_AVATAR_SIZE) {
        throw new AuthError('Foto de perfil muito grande. Escolha uma imagem menor.');
    }

    // FIX #4.3: Checagem com cache invalidation
    const existing = await stmtGetUser.get(cleanUser);
    if (existing) {
        throw new AuthError('Este nome de usuario ja esta em uso.');
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const now = Date.now();
    const finalDisplayName = (displayName || cleanUser).trim().slice(0, 30);

    // Consulta de contagem assíncrona no Turso
    try {
        const userCountRes = await db.execute('SELECT count(*) as count FROM users');
        const userCount = Number(userCountRes.rows[0].count);

        const role = userCount === 0
            ? 'Criador'
            : cleanUser === 'admin'
                ? 'Admin'
                : 'Membro';

        await stmtRegister.run(cleanUser, hashedPassword, finalDisplayName, avatar || '', role, '', now);
        
        // Invalida cache após criação
        invalidateUserCache(cleanUser);
    } catch (err) {
        if (err instanceof AuthError) throw err;
        if (err.message && err.message.includes('UNIQUE')) {
            throw new AuthError('Este nome de usuario ja esta em uso.');
        }
        console.error('[AUTH] Erro ao registrar usuário:', err.message);
        throw err;
    }

    const sessionToken = generateSessionToken(cleanUser);

    return {
        username: cleanUser,
        displayName: finalDisplayName,
        avatar: avatar || '',
        role: 'Criador',
        bio: '',
        banned: false,
        restrictedUntil: 0,
        sessionToken // Retorna token para reconexão futura
    };
}

// ============================================================
// AUTENTICAÇÃO DE USUÁRIO
// ============================================================

async function authenticateUser(username, password) {
    const cleanUser = (username || '').toLowerCase().trim();

    if (!cleanUser || typeof password !== 'string' || !password) {
        throw new AuthError('Informe usuario e senha.');
    }

    try {
        // FIX #4.3: Busca com cache
        const user = await stmtGetUser.get(cleanUser);
        if (!user) {
            throw new AuthError('Usuario ou senha incorretos.');
        }

        // Validação segura de senha
        const isValid = await bcrypt.compare(password, user.password);
        if (!isValid) {
            throw new AuthError('Usuario ou senha incorretos.');
        }

        const restriction = getRestrictionInfo(user);

        // FIX #4.2: Gera novo session token
        const sessionToken = generateSessionToken(cleanUser);

        return {
            username: user.username,
            displayName: user.displayName,
            avatar: user.avatar,
            role: user.role,
            bio: user.bio || '',
            banned: !!user.banned,
            restricted: restriction.restricted,
            restrictedUntil: restriction.restrictedUntil,
            sessionToken // Retorna para armazenar no cliente
        };
    } catch (err) {
        if (err instanceof AuthError) throw err;
        console.error('[AUTH] Erro ao autenticar:', err.message);
        throw err;
    }
}

// ============================================================
// VALIDAÇÃO DE USUÁRIO (Para middleware)
// ============================================================

async function validateUser(username) {
    if (!username) return null;

    try {
        const user = await stmtGetUser.get(username);
        if (!user) return null;

        return {
            username: user.username,
            displayName: user.displayName,
            avatar: user.avatar,
            role: user.role,
            bio: user.bio || '',
            banned: !!user.banned,
            restrictedUntil: Number(user.restrictedUntil) || 0
        };
    } catch (err) {
        console.error('[AUTH] Erro ao validar usuário:', err.message);
        return null;
    }
}

module.exports = {
    registerUser,
    authenticateUser,
    validateUser,
    reconnectWithToken,
    validateSessionToken,
    generateSessionToken,
    AuthError
};
