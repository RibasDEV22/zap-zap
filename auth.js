const bcrypt = require('bcryptjs');
const {
    stmtRegister,
    stmtGetUser,
    db
} = require('./db');

const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;
const MAX_AVATAR_SIZE = 400 * 1024;

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

async function registerUser(username, password, displayName, avatar) {
    const cleanUser = validateCredentials(username, password);

    if (avatar && avatar.length > MAX_AVATAR_SIZE) {
        throw new AuthError('Foto de perfil muito grande. Escolha uma imagem menor.');
    }

    // bcrypt.hash é a única parte assíncrona — precisa acontecer ANTES
    // da transação, para que checagem + insert fiquem 100% atômicos.
    const hashedPassword = await bcrypt.hash(password, 10);
    const now = Date.now();
    const finalDisplayName = (displayName || cleanUser).trim().slice(0, 30);

    const registerTx = db.transaction(() => {
        const existing = stmtGetUser.get(cleanUser);
        if (existing) {
            throw new AuthError('Este nome de usuario ja esta em uso.');
        }

        const userCount = db.prepare('SELECT count(*) as count FROM users').get().count;

        const role = userCount === 0
            ? 'Criador'
            : cleanUser === 'admin'
                ? 'Admin'
                : 'Membro';

        stmtRegister.run(cleanUser, hashedPassword, finalDisplayName, avatar || '', role, '', now);

        return role;
    });

    let role;
    try {
        role = registerTx();
    } catch (err) {
        if (err instanceof AuthError) throw err;
        if (err.message && err.message.includes('UNIQUE')) {
            throw new AuthError('Este nome de usuario ja esta em uso.');
        }
        throw err;
    }

    return {
        username: cleanUser,
        displayName: finalDisplayName,
        avatar: avatar || '',
        role,
        bio: '',
        banned: false,
        restrictedUntil: 0
    };
}

async function authenticateUser(username, password) {
    const cleanUser = (username || '').toLowerCase().trim();

    if (!cleanUser || typeof password !== 'string' || !password) {
        throw new AuthError('Informe usuario e senha.');
    }

    const user = stmtGetUser.get(cleanUser);
    if (!user) {
        throw new AuthError('Usuario ou senha incorretos.');
    }

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) {
        throw new AuthError('Usuario ou senha incorretos.');
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
        restrictedUntil: restriction.restrictedUntil
    };
}

module.exports = {
    registerUser,
    authenticateUser,
    AuthError
};
