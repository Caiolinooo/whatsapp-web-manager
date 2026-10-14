const test = require('node:test');
const assert = require('node:assert/strict');
const { idsBetween, applyClick } = require('../public/select');
const { sanitizeSegment, mediaKind, resolveInside } = require('../lib/files');
const { formatPhone } = require('../lib/phone');
const { toChatSummary, toMessageSummary } = require('../lib/chats');
const { buildConversationHtml } = require('../lib/html');
const { buildThreads } = require('../lib/threads');
const { createCache } = require('../lib/cache');
const { createAuth } = require('../lib/auth');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { createHub } = require('../server/hub');

test('shift seleciona o intervalo inclusive', () => {
  const ids = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  assert.deepEqual(idsBetween(ids, 'm5', 'm2'), ['m2', 'm3', 'm4', 'm5']);
  const result = applyClick(ids, new Set(), null, 'm2', { shift: false, toggle: false });
  const ranged = applyClick(ids, result.selected, result.anchorId, 'm5', { shift: true, toggle: false });
  assert.deepEqual([...ranged.selected], ['m2', 'm3', 'm4', 'm5']);
});

test('ctrl remove uma mensagem da seleção', () => {
  const ids = ['m1', 'm2'];
  const next = applyClick(ids, new Set(['m1', 'm2']), 'm2', 'm1', { shift: false, toggle: true });
  assert.deepEqual([...next.selected], ['m2']);
});

test('nome de pasta rejeita barra e nome reservado', () => {
  assert.equal(sanitizeSegment('a/b'), 'a b');
  assert.equal(sanitizeSegment('CON'), 'item');
  assert.equal(sanitizeSegment('..'), 'item');
});

test('tipo de arquivo cai na pasta certa', () => {
  assert.equal(mediaKind('image/webp', 'sticker'), 'figurinhas');
  assert.equal(mediaKind('image/png', 'image'), 'imagens');
  assert.equal(mediaKind('audio/ogg', 'ptt'), 'audios');
  assert.equal(mediaKind('video/mp4', 'video'), 'videos');
  assert.equal(mediaKind('application/pdf', 'document'), 'documentos');
});

test('resumo da conversa traz nome e número', () => {
  const chat = toChatSummary({
    id: '1@lid',
    name: 'Larissa',
    phone: '5522999701401',
    isGroup: false,
    unread: 0,
    timestamp: 10,
    preview: 'oi',
  });
  assert.equal(chat.name, 'Larissa');
  assert.equal(chat.numberLabel, '+55 22 99970-1401');
  assert.equal(chat.folderNumber, '5522999701401');
  const group = toChatSummary({ id: '2@g.us', name: 'ABZ', isGroup: true, phone: '999' });
  assert.equal(group.numberLabel, 'Grupo');
  assert.equal(group.folderNumber, 'grupo');
  assert.equal(group.number, '');
  assert.equal(toChatSummary({ id: '3', name: 'A', phone: '5511999999999', preview: 'image' }).preview, 'Imagem');
  assert.equal(toChatSummary({ id: '3', name: 'A', phone: '5511999999999', preview: '/9j/AAAA' }).preview, '');
});

test('só mensagem de localização vira mapa', () => {
  const image = toMessageSummary({ id: 'm', type: 'image', lat: 0, lng: 0, t: 1, body: '' });
  assert.equal(image.location, null);
  const pin = toMessageSummary({ id: 'p', type: 'location', lat: -22.9, lng: -43.1, loc: 'Niterói', t: 1 });
  assert.equal(pin.location.description, 'Niterói');
  assert.equal(pin.location.lng, -43.1);
});

test('telefone brasileiro formatado', () => {
  assert.equal(formatPhone('5511987654321'), '+55 11 98765-4321');
  assert.equal(formatPhone('551133334444'), '+55 11 3333-4444');
});

test('html da conversa escapa texto e aponta mídia relativa', () => {
  const html = buildConversationHtml({
    chat: { name: 'A <script>', numberLabel: '+55 11 98765-4321', isGroup: false },
    avatarFile: 'avatar.jpg',
    mediaMap: { '1': 'imagens/foto.png' },
    messages: [{
      id: '1',
      body: '<b>oi</b>',
      type: 'image',
      timestamp: 1760000000,
      fromMe: true,
      hasMedia: true,
      filename: 'foto.png',
    }],
  });
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('<b>'), false);
  assert.match(html, /A &lt;script&gt;/);
  assert.match(html, /src="imagens\/foto\.png"/);
  assert.match(html, /src="avatar\.jpg"/);
  assert.match(html, /class="msg out"/);
  assert.match(html, /\+55 11 98765-4321/);
});

test('o mesmo número em contas diferentes vira uma conversa', () => {
  const threads = buildThreads([
    { id: 'a@c.us', name: 'Maria', number: '5511987654321', isGroup: false, timestamp: 10, accountId: 'acc1', accountLabel: 'Loja', preview: 'oi' },
    { id: 'b@lid', name: 'Maria Silva', number: '5511987654321', isGroup: false, timestamp: 20, accountId: 'acc2', accountLabel: 'Pessoal', preview: 'foto' },
    { id: 'g@g.us', name: 'Família', isGroup: true, timestamp: 5, accountId: 'acc1', accountLabel: 'Loja' },
  ]);
  assert.equal(threads.length, 2);
  const maria = threads.find((item) => item.number === '5511987654321');
  assert.equal(maria.accounts.length, 2);
  assert.equal(maria.chatId, 'b@lid');
  assert.equal(maria.preview, 'foto');
  assert.equal(threads.some((item) => item.isGroup), true);
});

test('cache indexa texto e arquivo e esquece mensagem apagada', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-cache-'));
  const cache = createCache(dir);
  cache.remember({
    id: 'c1',
    name: 'Maria',
    number: '5511987654321',
    isGroup: false,
    accountId: 'a',
    accountLabel: 'Loja',
    timestamp: 10,
  }, [
    { id: 'm1', body: 'foto da obra', type: 'image', timestamp: 10, hasMedia: true, filename: 'obra.png', mimetype: 'image/png' },
    { id: 'm2', body: 'só texto', type: 'chat', timestamp: 11, hasMedia: false },
  ]);
  assert.equal(cache.search('obra', { kind: 'files' }).length, 1);
  assert.equal(cache.search('texto', { kind: 'messages' })[0].id, 'm2');
  assert.equal(cache.search('', { kind: 'files' }).length, 1);
  assert.equal(cache.search('', { kind: 'messages' }).length, 0);
  cache.forgetMessages(['m1']);
  assert.equal(cache.search('obra').length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('login trava depois de muitas senhas erradas e não aceita usuário curto', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'wa-auth-')), 'auth.json');
  const auth = createAuth(file);
  auth.setup({ username: 'ana', password: 'senha-forte' });
  assert.throws(() => auth.createUser({ username: 'ab', password: 'senha-forte', role: 'user' }), /Usuário/);
  for (let i = 0; i < 8; i += 1) {
    assert.throws(() => auth.login({ username: 'ana', password: 'errada', ip: '1' }), /inválidos/);
  }
  assert.throws(() => auth.login({ username: 'ana', password: 'senha-forte', ip: '1' }), /Muitas tentativas/);
  const ok = auth.login({ username: 'ana', password: 'senha-forte', ip: '2' });
  assert.equal(auth.sessionFromToken(ok.token).user.role, 'admin');
});

test('sessão antiga sobe mesmo com a pasta travada e move quando libera', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-legacy-'));
  const legacy = path.join(dir, 'session');
  fs.mkdirSync(path.join(dir, 'accounts', 'aaaaaaaaaaaa'), { recursive: true });
  fs.mkdirSync(legacy, { recursive: true });
  fs.writeFileSync(path.join(legacy, 'marker.txt'), 'sessao');
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    cwd: legacy,
    stdio: 'ignore',
  });
  const io = { emit() {} };
  await new Promise((resolve) => setTimeout(resolve, 400));
  try {
    const hub = createHub({ dataDir: dir, exportRoot: path.join(dir, 'exports'), io });
    assert.equal(hub.listAccounts()[0].label, 'Principal');
    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
    assert.equal(saved.accounts[0].sessionDir, 'session');
    assert.equal(fs.existsSync(path.join(legacy, 'marker.txt')), true);
    assert.equal(fs.existsSync(path.join(dir, 'accounts', 'aaaaaaaaaaaa')), false);
  } finally {
    child.kill();
  }
  let saved;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    createHub({ dataDir: dir, exportRoot: path.join(dir, 'exports'), io });
    saved = JSON.parse(fs.readFileSync(path.join(dir, 'accounts.json'), 'utf8'));
    if (!saved.accounts[0].sessionDir) break;
  }
  assert.equal(saved.accounts[0].sessionDir, undefined);
  const moved = path.join(dir, 'accounts', saved.accounts[0].id, 'session', 'marker.txt');
  assert.equal(fs.readFileSync(moved, 'utf8'), 'sessao');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('caminho fora da pasta de exportação é recusado', () => {
  const root = path.resolve('data/exports');
  assert.equal(resolveInside(root, path.join(root, '..', 'session')), null);
  assert.equal(resolveInside(root, path.join(root, 'Maria', '5511')), path.join(root, 'Maria', '5511'));
});
