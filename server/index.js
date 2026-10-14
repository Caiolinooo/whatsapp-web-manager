const express = require('express');
const http = require('http');
const path = require('path');
const { spawn } = require('child_process');
const { Server } = require('socket.io');
const { createDemoService } = require('./demo');
const { resolveInside } = require('../lib/files');
const { createAuth, readCookie, writeSessionCookie } = require('../lib/auth');
const { readMultipart, inferKind } = require('../lib/multipart');

const PUBLIC_API = new Set([
  '/api/auth/session',
  '/api/auth/login',
  '/api/auth/setup',
  '/api/auth/logout',
]);

function createApp(options = {}) {
  const demo = Boolean(options.demo);
  const dataDir = options.dataDir || path.join(__dirname, '..', 'data');
  const exportRoot = options.exportRoot || path.join(dataDir, 'exports');
  const app = express();
  const server = http.createServer(app);
  const io = new Server(server);
  const auth = demo ? null : createAuth(path.join(dataDir, 'auth.json'));
  const service = demo
    ? createDemoService({ exportRoot, io })
    : require('./hub').createHub({ dataDir, exportRoot, io });

  app.use(express.json({ limit: '1mb' }));

  if (auth) {
    app.use((req, res, next) => {
      if (!req.path.startsWith('/api/') || PUBLIC_API.has(req.path)) return next();
      const token = readCookie(req.headers.cookie, auth.cookieName);
      const session = auth.sessionFromToken(token);
      if (!session) return res.status(401).json({ error: 'Faça login para continuar' });
      req.user = session.user;
      next();
    });
    io.use((socket, next) => {
      const session = auth.sessionFromToken(readCookie(socket.handshake.headers.cookie, auth.cookieName));
      if (!session) return next(new Error('Faça login para continuar'));
      socket.data.user = session.user;
      next();
    });
  }

  function requireAdmin(req, res, next) {
    if (!auth) return res.status(404).json({ error: 'Não encontrado' });
    if (!req.user || req.user.role !== 'admin') {
      return res.status(403).json({ error: 'Apenas administradores' });
    }
    next();
  }

  app.get('/api/auth/session', (req, res) => {
    if (!auth) return res.json({ demo, user: null, needsSetup: false });
    const token = readCookie(req.headers.cookie, auth.cookieName);
    const session = auth.sessionFromToken(token);
    res.json({
      demo: false,
      needsSetup: auth.needsSetup(),
      user: session ? session.user : null,
    });
  });

  app.post('/api/auth/setup', (req, res, next) => {
    try {
      if (!auth) return res.status(404).json({ error: 'Não encontrado' });
      const user = auth.setup({ username: req.body?.username, password: req.body?.password });
      const result = auth.login({
        username: user.username,
        password: req.body?.password,
        ip: clientIp(req),
      });
      writeSessionCookie(res, auth.cookieName, result.token, auth.sessionSeconds);
      res.json({ user: result.user });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/login', (req, res, next) => {
    try {
      if (!auth) return res.status(404).json({ error: 'Não encontrado' });
      const result = auth.login({
        username: req.body?.username,
        password: req.body?.password,
        ip: clientIp(req),
      });
      writeSessionCookie(res, auth.cookieName, result.token, auth.sessionSeconds);
      res.json({ user: result.user });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/auth/logout', (req, res) => {
    if (auth) {
      auth.revokeToken(readCookie(req.headers.cookie, auth.cookieName));
      writeSessionCookie(res, auth.cookieName, '', 0);
    }
    res.json({ ok: true });
  });

  app.post('/api/auth/password', (req, res, next) => {
    try {
      if (!auth) return res.status(404).json({ error: 'Não encontrado' });
      const token = auth.changePassword(req.user.id, {
        current: req.body?.current,
        next: req.body?.next,
      });
      writeSessionCookie(res, auth.cookieName, token, auth.sessionSeconds);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/users', requireAdmin, (req, res) => {
    res.json({ users: auth.listUsers() });
  });

  app.post('/api/users', requireAdmin, (req, res, next) => {
    try {
      res.status(201).json({
        user: auth.createUser({
          username: req.body?.username,
          password: req.body?.password,
          role: req.body?.role,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/users/:id', requireAdmin, (req, res, next) => {
    try {
      res.json({
        user: auth.updateUser(req.user.id, req.params.id, {
          role: req.body?.role,
          disabled: req.body?.disabled,
          password: req.body?.password,
        }),
      });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/users/:id', requireAdmin, (req, res, next) => {
    try {
      auth.deleteUser(req.user.id, req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/status', (req, res) => {
    res.json(service.getStatus());
  });

  app.get('/api/qr', (req, res) => {
    const qr = service.getQr(req.query.accountId);
    if (!qr) return res.status(404).json({ error: 'QR indisponível' });
    res.json({ qr });
  });

  app.get('/api/accounts', (req, res) => {
    const accounts = typeof service.listAccounts === 'function'
      ? service.listAccounts()
      : (service.getStatus().accounts || []);
    res.json({ accounts });
  });

  app.post('/api/accounts', async (req, res, next) => {
    try {
      if (typeof service.createAccount !== 'function') {
        return res.status(400).json({ error: 'Vários números só existem fora da demonstração' });
      }
      res.status(201).json({ account: await service.createAccount(req.body?.label) });
    } catch (error) {
      next(error);
    }
  });

  app.patch('/api/accounts/:id', (req, res, next) => {
    try {
      if (typeof service.renameAccount !== 'function') {
        return res.status(400).json({ error: 'Vários números só existem fora da demonstração' });
      }
      res.json({ account: service.renameAccount(req.params.id, req.body?.label) });
    } catch (error) {
      next(error);
    }
  });

  app.delete('/api/accounts/:id', async (req, res, next) => {
    try {
      if (typeof service.removeAccount !== 'function') {
        return res.status(400).json({ error: 'Vários números só existem fora da demonstração' });
      }
      await service.removeAccount(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/accounts/:id/connect', async (req, res, next) => {
    try {
      if (typeof service.connectAccount !== 'function') {
        return res.status(400).json({ error: 'Vários números só existem fora da demonstração' });
      }
      res.json({ account: await service.connectAccount(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/accounts/:id/logout', async (req, res, next) => {
    try {
      if (typeof service.disconnectAccount !== 'function') {
        return res.status(400).json({ error: 'Vários números só existem fora da demonstração' });
      }
      res.json({ account: await service.disconnectAccount(req.params.id) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/accounts/:id/qr', (req, res) => {
    const qr = service.getQr(req.params.id);
    if (!qr) return res.status(404).json({ error: 'QR indisponível' });
    res.json({ qr });
  });

  app.post('/api/connect', async (req, res, next) => {
    try {
      await service.start();
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/logout', async (req, res, next) => {
    try {
      await service.stop();
      res.json(service.getStatus());
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/chats', async (req, res, next) => {
    try {
      res.json({ chats: await service.listChats() });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/chat', async (req, res, next) => {
    try {
      if (!req.query.chatId) return res.status(400).json({ error: 'Conversa ausente' });
      res.json({ chat: await service.getChat(req.query.chatId, req.query.accountId) });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/messages', async (req, res, next) => {
    try {
      if (!req.query.chatId) return res.status(400).json({ error: 'Conversa ausente' });
      res.json({
        messages: await service.listMessages(req.query.chatId, req.query.limit, req.query.accountId),
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/thread', async (req, res, next) => {
    try {
      if (!req.query.id) return res.status(400).json({ error: 'Conversa ausente' });
      if (typeof service.getThread !== 'function') {
        return res.status(404).json({ error: 'Não encontrado' });
      }
      res.json(await service.getThread(req.query.id, req.query.limit));
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/search', (req, res, next) => {
    try {
      if (typeof service.search !== 'function') return res.json({ results: [] });
      const results = service.search(req.query.q || '', {
        kind: req.query.kind || 'messages',
        accountId: req.query.accountId || '',
        limit: req.query.limit,
      });
      res.json({ results });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/cache', (req, res) => {
    res.json(typeof service.cacheStats === 'function'
      ? service.cacheStats()
      : { messages: 0, files: 0, chats: 0 });
  });

  app.get('/api/avatar', async (req, res, next) => {
    try {
      const file = await service.getAvatar(req.query.chatId, req.query.accountId);
      if (!file) return res.status(404).end();
      res.setHeader('Cache-Control', 'private, max-age=3600');
      if (typeof file === 'string') return res.sendFile(file);
      res.setHeader('Content-Type', file.mimetype || 'image/jpeg');
      res.send(file.buffer);
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/media', async (req, res, next) => {
    try {
      const file = await service.getMediaFile(req.query.messageId, req.query.accountId);
      if (!file) return res.status(404).end();
      res.setHeader('Content-Type', file.mimetype || 'application/octet-stream');
      res.setHeader('Cache-Control', 'private, max-age=86400');
      if (file.filename) {
        res.setHeader('Content-Disposition', `inline; filename="${String(file.filename).replace(/"/g, '')}"`);
      }
      if (file.path) return res.sendFile(file.path);
      res.send(file.buffer);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/messages/delete', async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body?.messageIds) ? req.body.messageIds.filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ error: 'Nenhuma mensagem selecionada' });
      const result = await service.deleteMessages(ids, Boolean(req.body?.everyone), (progress) => {
        io.emit('progress', { kind: 'delete', ...progress });
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/send', async (req, res, next) => {
    try {
      if (typeof service.sendMessage !== 'function') {
        return res.status(501).json({ error: 'Envio indisponível' });
      }
      let fields = req.body || {};
      let file = null;
      if (String(req.headers['content-type'] || '').includes('multipart/form-data')) {
        const parsed = await readMultipart(req);
        fields = parsed.fields;
        file = parsed.file;
      }
      const kind = inferKind(fields.kind, file);
      const result = await service.sendMessage({
        accountId: fields.accountId || '',
        chatId: fields.chatId || '',
        kind,
        text: fields.text || '',
        lat: fields.lat,
        lng: fields.lng,
        description: fields.description || '',
        contactName: fields.contactName || '',
        contactPhone: fields.contactPhone || '',
        file,
      });
      res.json(result);
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/export', async (req, res, next) => {
    try {
      const ids = Array.isArray(req.body?.chatIds) ? req.body.chatIds.filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ error: 'Nenhuma conversa selecionada' });
      const accountIds = req.body?.accountIds && typeof req.body.accountIds === 'object'
        ? req.body.accountIds
        : {};
      const exports = await service.exportChats(ids, (progress) => {
        io.emit('progress', { kind: 'export', ...progress });
      }, accountIds);
      res.json({
        exports: exports.map((item) => ({
          chatId: item.chatId,
          name: item.name,
          dir: item.dir,
          html: item.html,
          files: item.files,
          missing: item.missing,
        })),
      });
    } catch (error) {
      next(error);
    }
  });

  app.post('/api/backup', async (req, res, next) => {
    try {
      if (typeof service.backupChats !== 'function') {
        return res.status(501).json({ error: 'Backup indisponível' });
      }
      const ids = Array.isArray(req.body?.chatIds) ? req.body.chatIds.filter(Boolean) : [];
      if (!ids.length) return res.status(400).json({ error: 'Nenhuma conversa selecionada' });
      const result = await service.backupChats(ids, (progress) => {
        io.emit('progress', { kind: 'backup', ...progress });
      });
      res.json({
        id: result.id,
        dir: result.dir,
        threads: result.threads,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get('/api/backups', (req, res) => {
    const backups = typeof service.listBackups === 'function' ? service.listBackups() : [];
    res.json({ backups });
  });

  app.post('/api/open-folder', (req, res) => {
    const backupId = req.body?.backupId;
    let dir = null;
    let root = exportRoot;
    if (backupId && typeof service.backupDir === 'function') {
      dir = service.backupDir(backupId);
      root = typeof service.backupRoot === 'function' ? service.backupRoot() : exportRoot;
    } else {
      dir = service.exportDir(req.body?.chatId);
    }
    const safe = dir && resolveInside(root, dir);
    if (!safe) return res.status(404).json({ error: 'Pasta ainda não exportada' });
    openDir(safe);
    res.json({ dir: safe });
  });

  app.use('/api', (req, res) => {
    res.status(404).json({ error: 'Não encontrado' });
  });

  app.use((req, res, next) => {
    if (req.path.endsWith('.js') || req.path.endsWith('.css') || req.path === '/') {
      res.setHeader('Cache-Control', 'no-store');
    }
    next();
  });
  app.use(express.static(path.join(__dirname, '..', 'public')));

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const message = error && error.message ? String(error.message) : 'Erro interno';
    console.error(req.method, req.path, message);
    if (error && error.stack) console.error(error.stack.split('\n').slice(0, 4).join('\n'));
    res.status(error.status || 500).json({ error: message });
  });

  io.on('connection', (socket) => {
    socket.emit('status', service.getStatus());
    const qr = service.getQr();
    if (qr) socket.emit('qr', qr);
  });

  if (options.autoStart && (!auth || !auth.needsSetup())) {
    service.start().catch(() => {});
  }

  return { app, server, io, service, exportRoot, auth };
}

function clientIp(req) {
  return req.ip || (req.socket && req.socket.remoteAddress) || 'local';
}

function openDir(dir) {
  if (process.platform === 'win32') {
    spawn('explorer.exe', [dir], { detached: true, stdio: 'ignore' }).unref();
    return;
  }
  const command = process.platform === 'darwin' ? 'open' : 'xdg-open';
  spawn(command, [dir], { detached: true, stdio: 'ignore' }).unref();
}

if (require.main === module) {
  const demo = process.env.DEMO === '1';
  const { server } = createApp({ demo, autoStart: true });
  const port = Number(process.env.PORT) || 3789;
  server.listen(port, '127.0.0.1', () => {
    console.log(`WhatsApp Manager em http://127.0.0.1:${port}`);
  });
}

module.exports = { createApp };
