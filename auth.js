const bcrypt = require('bcryptjs');
const { stmtRegister, stmtGetUser, db } = require('./db');

const USERNAME_REGEX = /^[a-z0-9_]{3,20}$/;
const MAX_AVATAR_SIZE = 300 * 1024; // ~300KB em base64, evita fotos gigantes travando o banco/rede

class AuthError extends Error {}

function validateCredentials(username, password) {
    const cleanUser = (username || '').toLowerCase().trim();

    if (!USERNAME_REGEX.test(cleanUser)) {
        throw new AuthError('Usuário deve ter 3-20 caracteres (letras minúsculas, números e _).');
    }
    if (!password || password.length < 4) {
        throw new AuthError('Senha deve ter no mínimo 4 caracteres.');
    }
    return cleanUser;
}

async function registerUser(username, password, displayName, avatar) {
    const cleanUser = validateCredentials(username, password);

    if (avatar && avatar.length > MAX_AVATAR_SIZE) {
        throw new AuthError('Foto de perfil muito grande. Escolha uma imagem menor.');
    }

    const existing = stmtGetUser.get(cleanUser);
    if (existing) {
        throw new AuthError('Esse nome de usuário já está em uso.');
    }

    const userCount = db.prepare('SELECT count(*) as count FROM users').get().count;
    const role = userCount === 0 ? 'Criador' : (cleanUser === 'admin' ? 'Admin' : 'Membro');

    const hashedPassword = await bcrypt.hash(password, 10);
    const now = Date.now();
    const finalDisplayName = (displayName || cleanUser).trim().slice(0, 30);

    stmtRegister.run(cleanUser, hashedPassword, finalDisplayName, avatar || '', role, now);
    return { username: cleanUser, displayName: finalDisplayName, avatar: avatar || '', role };
}

async function authenticateUser(username, password) {
    const cleanUser = (username || '').toLowerCase().trim();
    if (!cleanUser || !password) throw new AuthError('Informe usuário e senha.');

    const user = stmtGetUser.get(cleanUser);
    if (!user) throw new AuthError('Usuário ou senha incorretos.');

    const isValid = await bcrypt.compare(password, user.password);
    if (!isValid) throw new AuthError('Usuário ou senha incorretos.');

    return { username: user.username, displayName: user.displayName, avatar: user.avatar, role: user.role };
}

module.exports = { registerUser, authenticateUser, AuthError };
