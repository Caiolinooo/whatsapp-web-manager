const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/index');

async function listen(ctx) {
  await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
  return ctx.server.address().port;
}

async function shutdown(ctx) {
  await new Promise((resolve) => ctx.io.close(() => resolve()));
  if (ctx.server.listening) {
    await new Promise((resolve) => ctx.server.close(() => resolve()));
  }
}

function cookieFrom(response) {
  const raw = response.headers.get('set-cookie') || '';
  return raw.split(';')[0];
}

test('demo busca no cache, envia arquivo, junta a conversa e gera backup', async () => {
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-platform-'));
  const ctx = createApp({ demo: true, exportRoot });
  try {
    const port = await listen(ctx);
    const base = `http://127.0.0.1:${port}`;
    const session = await fetch(`${base}/api/auth/session`).then((res) => res.json());
    assert.equal(session.demo, true);

    const thread = await fetch(`${base}/api/thread?id=c1`).then((res) => res.json());
    assert.equal(thread.thread.name, 'Maria Silva');
    assert.ok(thread.messages.some((message) => message.id === 'm9'));

    const files = await fetch(`${base}/api/search?q=contrato&kind=files`).then((res) => res.json());
    assert.equal(files.results[0].filename, 'contrato.pdf');
    const chats = await fetch(`${base}/api/search?q=maria&kind=chats`).then((res) => res.json());
    assert.equal(chats.results[0].chatId, 'c1');

    const sent = await fetch(`${base}/api/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: 'c1', kind: 'text', text: 'mensagem nova' }),
    }).then((res) => res.json());
    assert.equal(sent.ok, true);
    const again = await fetch(`${base}/api/search?q=mensagem%20nova`).then((res) => res.json());
    assert.equal(again.results[0].chatId, 'c1');

    const form = new FormData();
    form.set('chatId', 'c1');
    form.set('kind', 'document');
    form.set('text', 'segue planilha');
    form.set('file', new Blob(['coluna a'], { type: 'text/plain' }), 'planilha.txt');
    const uploaded = await fetch(`${base}/api/send`, { method: 'POST', body: form });
    assert.equal(uploaded.status, 200);
    const mediaId = (await uploaded.json()).id;
    const media = await fetch(`${base}/api/media?messageId=${mediaId}`);
    assert.equal(media.status, 200);
    assert.match(media.headers.get('content-type'), /text\/plain/);

    const backup = await fetch(`${base}/api/backup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatIds: ['c1'] }),
    }).then((res) => res.json());
    assert.ok(backup.id);
    const folder = path.join(exportRoot, 'backups', backup.id);
    assert.equal(fs.existsSync(path.join(folder, 'manifest.json')), true);
    const saved = fs.readFileSync(path.join(folder, 'Maria Silva', '5511987654321', 'mensagens.json'), 'utf8');
    assert.match(saved, /mensagem nova/);
    assert.match(saved, /planilha\.txt/);

    const closed = await fetch(`${base}/api/open-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ backupId: '../segredo' }),
    });
    assert.equal(closed.status, 404);
  } finally {
    await shutdown(ctx);
    fs.rmSync(exportRoot, { recursive: true, force: true });
  }
});

test('login protege a API e o administrador gere acessos', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-http-'));
  const ctx = createApp({ dataDir, exportRoot: path.join(dataDir, 'exports'), autoStart: false });
  try {
    const port = await listen(ctx);
    const base = `http://127.0.0.1:${port}`;
    const locked = await fetch(`${base}/api/chats`);
    assert.equal(locked.status, 401);

    const setup = await fetch(`${base}/api/auth/setup`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ana', password: 'senha-forte' }),
    });
    assert.equal(setup.status, 200);
    const adminCookie = cookieFrom(setup);

    const chats = await fetch(`${base}/api/chats`, { headers: { cookie: adminCookie } });
    assert.equal(chats.status, 200);
    const created = await fetch(`${base}/api/users`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie: adminCookie },
      body: JSON.stringify({ username: 'bia', password: 'outra-senha', role: 'user' }),
    });
    assert.equal(created.status, 201);

    const bia = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'bia', password: 'outra-senha' }),
    });
    const biaCookie = cookieFrom(bia);
    const forbidden = await fetch(`${base}/api/users`, { headers: { cookie: biaCookie } });
    assert.equal(forbidden.status, 403);

    const wrong = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'ana', password: 'nao-e-essa' }),
    });
    assert.equal(wrong.status, 401);

    await fetch(`${base}/api/auth/logout`, { method: 'POST', headers: { cookie: adminCookie } });
    const after = await fetch(`${base}/api/chats`, { headers: { cookie: adminCookie } });
    assert.equal(after.status, 401);
  } finally {
    await shutdown(ctx);
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});
