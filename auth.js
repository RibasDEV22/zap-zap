const bcrypt = require('bcryptjs');
const { stmtRegister, stmtGetUser, db } = require('./db');

async function registerUser(username, password, displayName, avatar) {
    const cleanUser = username.toLowerCase().trim();
    const userCount = db.prepare('SELECT count(*) as count FROM users').get().count;
    const role = userCount === 0 ? 'Criador' : (cleanUser === 'admin' ? 'Admin' : 'Membro');
    
    const hashedPassword = await bcrypt.hash(password, 10);
    const now = Date.now();

    stmtRegister.run(cleanUser, hashedPassword, displayName || cleanUser, avatar || '', role, now);
    return { username: cleanUser, displayName: displayName || cleanUser, avatar, role };
}

async function authenticateUser(username, password) {
    const cleanUser = username.toLowerCase().trim();
    const user = stmtGetUser.get(cleanUser);
    
    if (!user) return null;
    const isValid = await bcrypt.compare(password, user.password);
    
    if (!isValid) return null;
    return { username: user.username, displayName: user.displayName, avatar: user.avatar, role: user.role };
}

module.exports = { registerUser, authenticateUser };
