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

test('exporta pastas por contato, número e tipo e apaga mensagens', async () => {
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-export-'));
  const ctx = createApp({ demo: true, exportRoot });
  try {
    const port = await listen(ctx);
    const base = `http://127.0.0.1:${port}`;
    const status = await fetch(`${base}/api/status`).then((res) => res.json());
    assert.equal(status.demo, true);
    assert.equal(status.status, 'ready');

    const chats = await fetch(`${base}/api/chats`).then((res) => res.json());
    assert.equal(chats.chats[0].name, 'Maria Silva');
    assert.equal(chats.chats[0].numberLabel, '+55 11 98765-4321');

    const avatar = await fetch(`${base}/api/avatar?chatId=c1`);
    assert.equal(avatar.status, 200);
    assert.match(avatar.headers.get('content-type'), /image/);

    const closed = await fetch(`${base}/api/open-folder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: '../segredo' }),
    });
    assert.equal(closed.status, 404);

    const exported = await fetch(`${base}/api/export`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatIds: ['c1', 'c2', 'c3'] }),
    }).then((res) => res.json());
    assert.equal(exported.exports.length, 3);

    const maria = path.join(exportRoot, 'Maria Silva', '5511987654321');
    const html = fs.readFileSync(path.join(maria, 'conversa.html'), 'utf8');
    assert.match(html, /Maria Silva/);
    assert.match(html, /\+55 11 98765-4321/);
    assert.match(html, /src="imagens\//);
    assert.match(html, /href="documentos\//);
    const images = fs.readdirSync(path.join(maria, 'imagens'));
    const docs = fs.readdirSync(path.join(maria, 'documentos'));
    assert.ok(images.some((file) => file.endsWith('.png')));
    assert.ok(docs.some((file) => file.endsWith('.pdf')));
    assert.equal(fs.existsSync(path.join(maria, 'avatar.jpg')), true);
    assert.equal(fs.existsSync(path.join(exportRoot, 'João Souza', '5521999887766', 'conversa.html')), true);
    assert.equal(fs.existsSync(path.join(exportRoot, 'João Souza', '5521999887766', 'imagens')), false);
    assert.equal(fs.existsSync(path.join(exportRoot, 'Família', 'grupo', 'conversa.html')), true);

    const removed = await fetch(`${base}/api/messages/delete`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds: ['m2', 'm3', 'm4', 'm5'], everyone: false }),
    }).then((res) => res.json());
    assert.equal(removed.deleted.length, 4);
    const messages = await fetch(`${base}/api/messages?chatId=c1`).then((res) => res.json());
    const ids = messages.messages.map((message) => message.id);
    assert.equal(ids.includes('m2'), false);
    assert.equal(ids.includes('m1'), true);
    assert.equal(ids.includes('m6'), true);
    assert.equal(ids.includes('m9'), true);
  } finally {
    await shutdown(ctx);
    fs.rmSync(exportRoot, { recursive: true, force: true });
  }
});
