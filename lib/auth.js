const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const COOKIE = 'wam.sid';
const SESSION_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_ATTEMPTS = 8;
const WINDOW_MS = 10 * 60 * 1000;
const DUMMY_SALT = 'whatsapp-manager-dummy-salt';
const DUMMY_HASH = crypto.scryptSync('senha-inexistente', DUMMY_SALT, 32).toString('hex');

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(String(password), salt, 32).toString('hex');
  return { salt, hash };
}

function verifyPassword(password, salt, hash) {
  let actual;
  try {
    actual = crypto.scryptSync(String(password), String(salt || DUMMY_SALT), 32);
  } catch (error) {
    return false;
  }
  const expected = Buffer.from(String(hash || ''), 'hex');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

function publicUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role,
    disabled: Boolean(user.disabled),
    createdAt: user.createdAt,
  };
}

function validUsername(value) {
  return /^[a-z0-9._-]{3,32}$/.test(String(value || ''));
}

function validPassword(value) {
  const text = String(value || '');
  return text.length >= 8 && text.length <= 200;
}

function createAuth(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const attempts = new Map();
  let state = { users: [], sessions: [] };

  function load() {
    if (!fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = {
        users: Array.isArray(parsed.users) ? parsed.users : [],
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions : [],
      };
    } catch (error) {
      state = { users: [], sessions: [] };
    }
  }

  function save() {
    const temp = `${file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(state, null, 2));
    fs.renameSync(temp, file);
  }

  function pruneSessions() {
    const now = Date.now();
    state.sessions = state.sessions.filter((session) => session.expiresAt > now);
  }

  function userByName(username) {
    const key = String(username || '').trim().toLowerCase();
    return state.users.find((user) => user.username === key) || null;
  }

  function userById(id) {
    return state.users.find((user) => user.id === id) || null;
  }

  function tooMany(ip) {
    const now = Date.now();
    const rows = (attempts.get(ip) || []).filter((stamp) => now - stamp < WINDOW_MS);
    attempts.set(ip, rows);
    return rows.length >= MAX_ATTEMPTS;
  }

  function markFailure(ip) {
    const rows = attempts.get(ip) || [];
    rows.push(Date.now());
    attempts.set(ip, rows);
  }

  function clearFailures(ip) {
    attempts.delete(ip);
  }

  function issue(user) {
    pruneSessions();
    const token = crypto.randomBytes(32).toString('hex');
    const session = {
      id: crypto.createHash('sha256').update(token).digest('hex'),
      userId: user.id,
      expiresAt: Date.now() + SESSION_MS,
    };
    const mine = state.sessions.filter((item) => item.userId === user.id);
    if (mine.length >= 20) {
      mine.sort((a, b) => a.expiresAt - b.expiresAt);
      const drop = new Set(mine.slice(0, mine.length - 19).map((item) => item.id));
      state.sessions = state.sessions.filter((item) => !drop.has(item.id));
    }
    state.sessions.push(session);
    save();
    return token;
  }

  function sessionFromToken(token) {
    if (!token) return null;
    pruneSessions();
    const id = crypto.createHash('sha256').update(String(token)).digest('hex');
    const session = state.sessions.find((item) => item.id === id);
    if (!session) return null;
    const user = userById(session.userId);
    if (!user || user.disabled) return null;
    return { tokenId: session.id, user: publicUser(user) };
  }

  function revokeToken(token) {
    if (!token) return;
    const id = crypto.createHash('sha256').update(String(token)).digest('hex');
    state.sessions = state.sessions.filter((item) => item.id !== id);
    save();
  }

  function setup({ username, password }) {
    if (state.users.length) {
      const error = new Error('O acesso inicial já foi criado');
      error.status = 409;
      throw error;
    }
    return createUser({ username, password, role: 'admin' });
  }

  function createUser({ username, password, role }) {
    const name = String(username || '').trim().toLowerCase();
    if (!validUsername(name)) {
      const error = new Error('Usuário: 3 a 32 letras, números, ponto, _ ou -');
      error.status = 400;
      throw error;
    }
    if (!validPassword(password)) {
      const error = new Error('A senha precisa ter entre 8 e 200 caracteres');
      error.status = 400;
      throw error;
    }
    if (userByName(name)) {
      const error = new Error('Esse usuário já existe');
      error.status = 409;
      throw error;
    }
    const nextRole = role === 'admin' ? 'admin' : 'user';
    const user = {
      id: crypto.randomBytes(8).toString('hex'),
      username: name,
      ...hashPassword(password),
      role: nextRole,
      disabled: false,
      createdAt: new Date().toISOString(),
    };
    state.users.push(user);
    save();
    return publicUser(user);
  }

  function login({ username, password, ip }) {
    if (tooMany(ip || 'local')) {
      const error = new Error('Muitas tentativas. Espere alguns minutos.');
      error.status = 429;
      throw error;
    }
    const user = userByName(username);
    const salt = user ? user.salt : DUMMY_SALT;
    const hash = user ? user.hash : DUMMY_HASH;
    const ok = verifyPassword(password, salt, hash);
    if (!user || !ok) {
      markFailure(ip || 'local');
      const error = new Error('Usuário ou senha inválidos');
      error.status = 401;
      throw error;
    }
    if (user.disabled) {
      const error = new Error('Usuário desativado');
      error.status = 403;
      throw error;
    }
    clearFailures(ip || 'local');
    return { user: publicUser(user), token: issue(user) };
  }

  function changePassword(userId, { current, next }) {
    const user = userById(userId);
    if (!user || !verifyPassword(current, user.salt, user.hash)) {
      const error = new Error('Senha atual incorreta');
      error.status = 403;
      throw error;
    }
    if (!validPassword(next)) {
      const error = new Error('A senha precisa ter entre 8 e 200 caracteres');
      error.status = 400;
      throw error;
    }
    const hashed = hashPassword(next);
    user.salt = hashed.salt;
    user.hash = hashed.hash;
    state.sessions = state.sessions.filter((item) => item.userId !== user.id);
    save();
    return issue(user);
  }

  function updateUser(actorId, id, patch) {
    const user = userById(id);
    if (!user) {
      const error = new Error('Usuário não encontrado');
      error.status = 404;
      throw error;
    }
    if (patch.password) {
      if (!validPassword(patch.password)) {
        const error = new Error('A senha precisa ter entre 8 e 200 caracteres');
        error.status = 400;
        throw error;
      }
      const hashed = hashPassword(patch.password);
      user.salt = hashed.salt;
      user.hash = hashed.hash;
      state.sessions = state.sessions.filter((item) => item.userId !== user.id);
    }
    if (patch.role === 'admin' || patch.role === 'user') {
      if (user.id === actorId && patch.role !== 'admin') {
        const error = new Error('Você não pode tirar o próprio acesso de administrador');
        error.status = 400;
        throw error;
      }
      const admins = state.users.filter((item) => item.role === 'admin' && !item.disabled && item.id !== user.id);
      if (user.role === 'admin' && patch.role !== 'admin' && !admins.length) {
        const error = new Error('Precisa existir outro administrador');
        error.status = 400;
        throw error;
      }
      user.role = patch.role;
    }
    if (typeof patch.disabled === 'boolean') {
      if (user.id === actorId && patch.disabled) {
        const error = new Error('Você não pode desativar a própria conta');
        error.status = 400;
        throw error;
      }
      user.disabled = patch.disabled;
      if (patch.disabled) {
        state.sessions = state.sessions.filter((item) => item.userId !== user.id);
      }
    }
    save();
    return publicUser(user);
  }

  function deleteUser(actorId, id) {
    const user = userById(id);
    if (!user) {
      const error = new Error('Usuário não encontrado');
      error.status = 404;
      throw error;
    }
    if (user.id === actorId) {
      const error = new Error('Você não pode excluir a própria conta');
      error.status = 400;
      throw error;
    }
    const admins = state.users.filter((item) => item.role === 'admin' && item.id !== user.id);
    if (user.role === 'admin' && !admins.length) {
      const error = new Error('Precisa existir outro administrador');
      error.status = 400;
      throw error;
    }
    state.users = state.users.filter((item) => item.id !== user.id);
    state.sessions = state.sessions.filter((item) => item.userId !== user.id);
    save();
  }

  load();
  pruneSessions();

  return {
    cookieName: COOKIE,
    sessionSeconds: Math.floor(SESSION_MS / 1000),
    needsSetup: () => state.users.length === 0,
    listUsers: () => state.users.map(publicUser),
    setup,
    createUser,
    login,
    changePassword,
    updateUser,
    deleteUser,
    sessionFromToken,
    revokeToken,
  };
}

function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== name) continue;
    try {
      return decodeURIComponent(part.slice(eq + 1).trim());
    } catch (error) {
      return '';
    }
  }
  return '';
}

function writeSessionCookie(res, name, token, maxAge) {
  const value = token ? encodeURIComponent(token) : '';
  res.setHeader('Set-Cookie', `${name}=${value}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
}

module.exports = {
  createAuth,
  readCookie,
  writeSessionCookie,
  hashPassword,
  verifyPassword,
  validUsername,
  validPassword,
};
