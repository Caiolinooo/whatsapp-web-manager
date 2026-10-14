const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { createWaService } = require('./wa');
const { createCache } = require('../lib/cache');
const { createTrash } = require('../lib/trash');
const { writeBackup, listBackupFolders } = require('../lib/backup');
const { buildThreads, matchThreads, threadKey } = require('../lib/threads');
const { resolveInside } = require('../lib/files');

const MAX_ACCOUNTS = 8;

function httpError(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function validId(id) {
  return /^[a-f0-9]{12}$/.test(String(id || ''));
}

function createHub({ dataDir, exportRoot, io }) {
  const accountsDir = path.join(dataDir, 'accounts');
  const backupRoot = path.join(dataDir, 'backups');
  const registryPath = path.join(dataDir, 'accounts.json');
  const cache = createCache(path.join(dataDir, 'cache'));
  const trash = createTrash({ dir: path.join(dataDir, 'trash') });
  fs.mkdirSync(accountsDir, { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true });
  fs.mkdirSync(exportRoot, { recursive: true });

  const runtime = new Map();
  let meta = [];
  let publishTimer = null;
  const mediaQueue = [];
  let mediaActive = 0;

  function loadMeta() {
    if (!fs.existsSync(registryPath)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(registryPath, 'utf8'));
      const rows = Array.isArray(parsed.accounts) ? parsed.accounts : [];
      meta = rows.filter((row) => row && validId(row.id)).map((row) => {
        const record = {
          id: row.id,
          label: String(row.label || 'WhatsApp').slice(0, 40),
          createdAt: row.createdAt || new Date().toISOString(),
        };
        if (typeof row.sessionDir === 'string' && row.sessionDir && !row.sessionDir.includes('\0')) {
          const abs = path.resolve(dataDir, row.sessionDir);
          if (insideData(abs) && path.resolve(abs) !== path.resolve(dataDir)) record.sessionDir = abs;
        }
        return record;
      });
    } catch (error) {
      meta = [];
    }
  }

  function insideData(target) {
    const root = path.resolve(dataDir);
    const resolved = path.resolve(target);
    return resolved === root || resolved.startsWith(root + path.sep);
  }

  function saveMeta() {
    const accounts = meta.map((row) => {
      const saved = { id: row.id, label: row.label, createdAt: row.createdAt };
      if (row.sessionDir && insideData(row.sessionDir)) {
        saved.sessionDir = path.relative(dataDir, row.sessionDir);
      }
      return saved;
    });
    const temp = `${registryPath}.tmp`;
    fs.writeFileSync(temp, JSON.stringify({ accounts }, null, 2));
    fs.renameSync(temp, registryPath);
  }

  function accountDataDir(record) {
    if (record.sessionDir && insideData(record.sessionDir)) return path.dirname(record.sessionDir);
    return path.join(accountsDir, record.id);
  }

  function readNames(dir) {
    try {
      return fs.readdirSync(dir);
    } catch (error) {
      return [];
    }
  }

  function removeEmpty(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    if (readNames(dir).length) return;
    try { fs.rmdirSync(dir); } catch (error) { /* pasta ainda em uso */ }
  }

  // Chrome trava a pasta da sessão no Windows. Renomear falha com EPERM.
  // Copiar um perfil aberto pode corromper o login, então a pasta fica onde está.
  function relocateSession(from, to) {
    if (!fs.existsSync(from) || !readNames(from).length) return 'missing';
    if (path.resolve(from) === path.resolve(to)) return 'moved';
    if (fs.existsSync(to) && readNames(to).length) return 'kept';
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (fs.existsSync(to)) fs.rmSync(to, { recursive: true, force: true });
    try {
      fs.renameSync(from, to);
      return 'moved';
    } catch (error) {
      const locked = ['EPERM', 'EACCES', 'EBUSY', 'ENOTEMPTY', 'EXDEV'].includes(error.code);
      if (!locked) throw error;
      if (error.code !== 'EXDEV') return 'kept';
    }
    try {
      fs.cpSync(from, to, { recursive: true });
      fs.rmSync(from, { recursive: true, force: true });
    } catch (error) {
      fs.rmSync(to, { recursive: true, force: true });
      throw error;
    }
    return 'moved';
  }

  function migrateLegacy() {
    try {
      if (!meta.length) claimLegacySession();
      finishPendingMoves();
      sweepUnknownAccounts();
    } catch (error) {
      console.error('Migração da sessão antiga falhou:', error.message);
    }
  }

  function claimLegacySession() {
    const legacy = path.join(dataDir, 'session');
    if (!fs.existsSync(legacy) || !readNames(legacy).length) return;
    const id = crypto.randomBytes(6).toString('hex');
    const dest = path.join(accountsDir, id, 'session');
    const record = { id, label: 'Principal', createdAt: new Date().toISOString() };
    let outcome = 'kept';
    try {
      outcome = relocateSession(legacy, dest);
    } catch (error) {
      console.error('Não foi possível mover data/session:', error.message);
    }
    if (outcome === 'missing') {
      removeEmpty(path.dirname(dest));
      return;
    }
    if (outcome !== 'moved') {
      record.sessionDir = legacy;
      removeEmpty(path.dirname(dest));
    }
    meta.push(record);
    saveMeta();
  }

  function finishPendingMoves() {
    let changed = false;
    let stuck = false;
    for (const record of meta) {
      if (!record.sessionDir) continue;
      if (!fs.existsSync(record.sessionDir)) {
        delete record.sessionDir;
        changed = true;
        continue;
      }
      const dest = path.join(accountsDir, record.id, 'session');
      let outcome = 'kept';
      try {
        outcome = relocateSession(record.sessionDir, dest);
      } catch (error) {
        console.error(`Sessão de ${record.label} continua em uso:`, error.message);
      }
      if (outcome === 'moved') {
        delete record.sessionDir;
        changed = true;
      } else {
        stuck = true;
        removeEmpty(path.dirname(dest));
      }
    }
    if (changed) saveMeta();
    if (stuck) {
      console.warn('A pasta data/session está em uso. O número Principal continua nela. Feche o Chrome aberto por este programa e inicie de novo para mover a sessão.');
    }
  }

  function sweepUnknownAccounts() {
    const known = new Set(meta.map((row) => row.id));
    let changed = false;
    for (const name of readNames(accountsDir)) {
      if (!validId(name) || known.has(name)) continue;
      const dir = path.join(accountsDir, name);
      const session = path.join(dir, 'session');
      if (fs.existsSync(session) && readNames(session).length) {
        meta.push({
          id: name,
          label: meta.some((row) => row.label === 'Principal') ? 'WhatsApp' : 'Principal',
          createdAt: new Date().toISOString(),
        });
        known.add(name);
        changed = true;
        continue;
      }
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch (error) { /* ignora */ }
    }
    if (changed) saveMeta();
  }

  function schedulePublish() {
    if (publishTimer) return;
    publishTimer = setTimeout(() => {
      publishTimer = null;
      io.emit('status', getStatus());
    }, 80);
  }

  function pumpMedia() {
    if (mediaActive || !mediaQueue.length) return;
    const job = mediaQueue.shift();
    const row = runtime.get(job.accountId);
    if (!row) {
      pumpMedia();
      return;
    }
    mediaActive += 1;
    row.service.getMediaFile(job.messageId).then((file) => {
      if (file) cache.attachFile(job.accountId, job.messageId, file);
    }).catch(() => {}).finally(() => {
      mediaActive -= 1;
      pumpMedia();
    });
  }

  function queueMedia(accountId, messageId) {
    mediaQueue.push({ accountId, messageId });
    pumpMedia();
  }

  function accountStatus(row) {
    const status = row.service.getStatus();
    return {
      id: row.id,
      label: row.label,
      status: status.status,
      error: status.error,
      percent: status.percent,
      me: status.me,
      hasQr: Boolean(status.hasQr),
    };
  }

  function getStatus() {
    const accounts = [...runtime.values()].map(accountStatus);
    const ready = accounts.find((item) => item.status === 'ready');
    const pending = accounts.find((item) => item.status === 'qr' || item.status === 'loading' || item.status === 'starting');
    let status = 'idle';
    if (ready) status = 'ready';
    else if (pending) status = pending.status;
    else if (accounts.some((item) => item.status === 'error')) status = 'error';
    return {
      demo: false,
      multi: true,
      status,
      error: (accounts.find((item) => item.error) || {}).error || null,
      percent: pending ? pending.percent : null,
      me: ready ? ready.me : null,
      hasQr: accounts.some((item) => item.hasQr),
      accounts,
      cache: cache.stats(),
    };
  }

  function busFor(id) {
    return {
      emit(event, payload) {
        const row = runtime.get(id);
        if (!row) return;
        io.emit('account', {
          accountId: id,
          label: row.label,
          event,
          payload,
        });
        schedulePublish();
      },
    };
  }

  function archiveRecords(accountId, records, reason) {
    if (!records.length) return null;
    const row = runtime.get(accountId);
    const meta = trash.archive({
      accountId,
      accountLabel: row ? row.label : '',
      chatId: records[0].chatId || '',
      chatName: records[0].chatName || '',
      isGroup: Boolean(records[0].isGroup),
      reason,
      records,
    });
    if (meta) io.emit('trash-updated', { accountId, id: meta.id, reason });
    return meta;
  }

  // Mensagem apagada no celular: vai para a lixeira com a mídia já baixada,
  // mas CONTINUA no cache do projeto (a garantia de backup)
  function onRevoked(row, messageId) {
    const record = cache.findMessage(messageId);
    if (!record) return;
    archiveRecords(row.id, [record], 'revoked-phone');
  }

  function rememberLive(row, chat, message) {
    const taggedChat = {
      ...chat,
      accountId: row.id,
      accountLabel: row.label,
      threadKey: threadKey({ ...chat, accountId: row.id }),
    };
    const taggedMessage = {
      ...message,
      accountId: row.id,
      accountLabel: row.label,
    };
    cache.remember(taggedChat, [taggedMessage]);
    io.emit('live', { accountId: row.id, chat: taggedChat, message: taggedMessage });
    if (taggedMessage.hasMedia) queueMedia(row.id, taggedMessage.id);
  }

  function ensureRuntime(record) {
    if (runtime.has(record.id)) return runtime.get(record.id);
    const row = {
      id: record.id,
      label: record.label,
      service: null,
    };
    runtime.set(record.id, row);
    row.service = createWaService({
      dataDir: accountDataDir(record),
      exportRoot,
      io: busFor(record.id),
      onLive: (chat, message) => rememberLive(row, chat, message),
      onRevoke: (messageId) => onRevoked(row, messageId),
    });
    return row;
  }

  function requireRow(id) {
    if (!validId(id) || !runtime.has(id)) throw httpError('Conta não encontrada', 404);
    return runtime.get(id);
  }

  function tagChat(row, chat) {
    return {
      ...chat,
      accountId: row.id,
      accountLabel: row.label,
      threadKey: threadKey({ ...chat, accountId: row.id }),
    };
  }

  async function collectTagged() {
    const all = [];
    for (const row of runtime.values()) {
      const fromCache = () => {
        for (const chat of cache.listChats()) {
          if (chat.accountId === row.id) all.push({ ...chat, accountLabel: row.label });
        }
      };
      if (row.service.getStatus().status !== 'ready') {
        fromCache();
        continue;
      }
      let chats = null;
      try {
        chats = await Promise.race([
          row.service.listChats(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 20000)),
        ]);
      } catch (error) {
        // Conta pronta mas página travada: a lista não pode cair por causa dela.
        fromCache();
        continue;
      }
      for (const chat of chats || []) {
        const tagged = tagChat(row, chat);
        cache.remember(tagged, []);
        all.push(tagged);
      }
    }
    return all;
  }

  function toListRow(thread) {
    const labels = [...new Set((thread.accounts || []).map((item) => item.label).filter(Boolean))];
    return {
      id: thread.chatId,
      chatId: thread.chatId,
      threadId: thread.id,
      name: thread.name,
      number: thread.number,
      numberLabel: thread.numberLabel,
      folderNumber: thread.folderNumber,
      isGroup: thread.isGroup,
      unread: thread.unread,
      timestamp: thread.timestamp,
      preview: thread.preview,
      accountId: thread.accountId || '',
      accountLabel: labels.join(' · '),
      accounts: thread.accounts || [],
    };
  }

  function ownerOf(chatId, accountId) {
    if (accountId && runtime.has(accountId)) return runtime.get(accountId);
    const hits = [];
    for (const chat of cache.listChats()) {
      if (chat.id !== chatId) continue;
      const row = runtime.get(chat.accountId);
      if (row && !hits.includes(row)) hits.push(row);
    }
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
    const ready = [...runtime.values()].filter((row) => row.service.getStatus().status === 'ready');
    return ready.length === 1 ? ready[0] : null;
  }

  function requireOwner(chatId, accountId) {
    const row = ownerOf(chatId, accountId);
    if (!row) throw httpError('Escolha de qual número essa conversa sai', 409);
    if (row.service.getStatus().status !== 'ready') {
      throw httpError('Esse número ainda não está conectado', 409);
    }
    return row;
  }

  async function listChats() {
    const threads = buildThreads(await collectTagged());
    return threads.map(toListRow);
  }

  async function getChat(chatId, accountId) {
    const row = requireOwner(chatId, accountId);
    return tagChat(row, await row.service.getChat(chatId));
  }

  async function listMessages(chatId, limit, accountId) {
    const row = requireOwner(chatId, accountId);
    const chat = tagChat(row, await row.service.getChat(chatId));
    const messages = await row.service.listMessages(chatId, limit);
    cache.remember(chat, messages.map((message) => ({
      ...message,
      accountId: row.id,
      accountLabel: row.label,
    })));
    // Backup contínuo: baixa em segundo plano a mídia do histórico que ainda não temos
    for (const message of messages) {
      if (!message.hasMedia) continue;
      const stored = cache.findMessage(message.id);
      if (stored && !stored.filePath) queueMedia(row.id, message.id);
    }
    return messages;
  }

  async function getThread(id, limit) {
    const threads = buildThreads(await collectTagged());
    const thread = threads.find((item) => item.id === id || item.chatId === id);
    if (!thread) throw httpError('Conversa não encontrada', 404);
    const cap = Math.min(Math.max(Number(limit) || 80, 1), 5000);
    for (const link of thread.accounts) {
      const row = runtime.get(link.accountId);
      if (!row || row.service.getStatus().status !== 'ready') continue;
      try {
        const chat = tagChat(row, await row.service.getChat(link.chatId));
        const messages = await row.service.listMessages(link.chatId, cap);
        cache.remember(chat, messages.map((message) => ({
          ...message,
          accountId: row.id,
          accountLabel: row.label,
        })));
      } catch (error) { /* uma conta fora do ar não esvazia a conversa unida */ }
    }
    const messages = cache.messagesForThread(thread.id).slice(-cap);
    return { thread: toListRow(thread), messages };
  }

  function search(query, options = {}) {
    const kind = options.kind || 'messages';
    if (kind === 'chats') {
      const threads = buildThreads(cache.listChats()).map(toListRow);
      return matchThreads(threads, query, options.accountId || '').slice(0, 80);
    }
    return cache.search(query, options);
  }

  async function createAccount(label) {
    if (meta.length >= MAX_ACCOUNTS) {
      throw httpError(`Limite de ${MAX_ACCOUNTS} números nesta máquina`, 400);
    }
    const id = crypto.randomBytes(6).toString('hex');
    const record = {
      id,
      label: String(label || '').trim().slice(0, 40) || 'WhatsApp',
      createdAt: new Date().toISOString(),
    };
    meta.push(record);
    saveMeta();
    const row = ensureRuntime(record);
    schedulePublish();
    await row.service.start();
    return accountStatus(row);
  }

  async function connectAccount(id) {
    const row = requireRow(id);
    await row.service.start();
    schedulePublish();
    return accountStatus(row);
  }

  async function disconnectAccount(id) {
    const row = requireRow(id);
    await row.service.stop();
    schedulePublish();
    return accountStatus(row);
  }

  function renameAccount(id, label) {
    const row = requireRow(id);
    const next = String(label || '').trim().slice(0, 40);
    if (!next) throw httpError('Dê um nome para o número', 400);
    row.label = next;
    const record = meta.find((item) => item.id === id);
    if (record) record.label = next;
    saveMeta();
    schedulePublish();
    return accountStatus(row);
  }

  async function removeAccount(id) {
    const row = requireRow(id);
    const record = meta.find((item) => item.id === id);
    await row.service.stop().catch(() => {});
    runtime.delete(id);
    meta = meta.filter((item) => item.id !== id);
    saveMeta();
    cache.forgetAccount(id);
    fs.rmSync(path.join(accountsDir, id), { recursive: true, force: true });
    const sessionDir = record && record.sessionDir;
    if (sessionDir && insideData(sessionDir) && path.resolve(sessionDir) !== path.resolve(dataDir)) {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    }
    schedulePublish();
  }

  async function start() {
    if (!meta.length) return createAccount('Principal');
    await Promise.all([...runtime.values()].map((row) => row.service.start().catch((error) => {
      console.error(row.label, error.message || error);
    })));
    schedulePublish();
  }

  async function stop() {
    await Promise.all([...runtime.values()].map((row) => row.service.stop().catch(() => {})));
    schedulePublish();
  }

  function getQr(accountId) {
    if (accountId) {
      const row = runtime.get(accountId);
      return row ? row.service.getQr() : null;
    }
    for (const row of runtime.values()) {
      const qr = row.service.getQr();
      if (qr) return qr;
    }
    return null;
  }

  async function getAvatar(chatId, accountId) {
    const row = ownerOf(chatId, accountId);
    if (!row) return null;
    return row.service.getAvatar(chatId);
  }

  async function getMediaFile(messageId, accountId) {
    if (!messageId) return null;
    const record = cache.findMessage(messageId);
    if (record && record.filePath && fs.existsSync(record.filePath)) {
      return { path: record.filePath, mimetype: record.mimetype, filename: record.filename };
    }
    const ownerId = accountId || (record && record.accountId);
    const row = ownerId ? runtime.get(ownerId) : null;
    if (!row) return null;
    const file = await row.service.getMediaFile(messageId);
    if (file) cache.attachFile(row.id, messageId, file);
    return file;
  }

  // Mapeia mensagem → número dono, para a guarda de remoção por usuário
  function messageAccountIds(ids) {
    const map = {};
    for (const id of ids || []) {
      const record = cache.findMessage(id);
      map[id] = record ? record.accountId : null;
    }
    return map;
  }

  async function deleteMessages(ids, everyone, onProgress) {
    const groups = new Map();
    const unknown = [];
    for (const id of ids) {
      const record = cache.findMessage(id);
      let row = record && runtime.get(record.accountId);
      if (!row) {
        const ready = [...runtime.values()].filter((item) => item.service.getStatus().status === 'ready');
        if (ready.length === 1) row = ready[0];
      }
      if (!row) {
        unknown.push(id);
        continue;
      }
      if (!groups.has(row.id)) groups.set(row.id, []);
      groups.get(row.id).push(id);
    }
    const deleted = [];
    const failed = unknown.map((id) => ({ id, error: 'Mensagem ainda não está no cache' }));
    let index = 0;
    const total = ids.length;
    for (const [accountId, messageIds] of groups) {
      const row = runtime.get(accountId);
      const result = await row.service.deleteMessages(messageIds, everyone, () => {
        index += 1;
        if (onProgress) onProgress({ index, total });
      });
      deleted.push(...result.deleted);
      failed.push(...result.failed);
    }
    // Lixeira: tudo que foi apagado com sucesso é arquivado (com mídia) antes de sair do cache
    if (deleted.length) {
      const records = deleted.map((id) => cache.findMessage(id)).filter(Boolean);
      const byChat = new Map();
      for (const record of records) {
        const key = `${record.accountId}|${record.chatId}`;
        if (!byChat.has(key)) byChat.set(key, []);
        byChat.get(key).push(record);
      }
      for (const [key, group] of byChat) {
        archiveRecords(key.split('|')[0], group, 'deleted-app');
      }
    }
    cache.forgetMessages(deleted);
    return { deleted, failed };
  }

  function listTrash(accountId) {
    return trash.list(accountId || undefined).map((entry) => ({
      id: entry.id,
      accountId: entry.accountId,
      accountLabel: entry.accountLabel,
      chatId: entry.chatId,
      chatName: entry.chatName,
      isGroup: entry.isGroup,
      reason: entry.reason,
      deletedAt: entry.deletedAt,
      restoredAt: entry.restoredAt || 0,
      count: entry.messages.length,
      preview: (entry.messages[0] && (entry.messages[0].body || entry.messages[0].filename || entry.messages[0].mimetype)) || '',
      withMedia: entry.messages.filter((message) => message.mediaFile).length,
    }));
  }

  // Restaura uma entrada da lixeira para o cache do projeto e, se pedido,
  // re-envia o conteúdo ao WhatsApp (chega como mensagem nova, com crédito de origem)
  async function restoreTrash(accountId, entryId, toWhatsApp) {
    const entry = trash.get(accountId, entryId);
    if (!entry) throw httpError('Entrada não encontrada na lixeira', 404);
    const row = runtime.get(accountId);
    if (!row) throw httpError('Número não encontrado', 404);

    const last = entry.messages[entry.messages.length - 1];
    const chat = {
      id: entry.chatId,
      name: entry.chatName,
      isGroup: entry.isGroup,
      timestamp: last ? last.timestamp : 0,
      preview: last ? (last.body || last.type) : '',
      accountId,
      accountLabel: row.label,
    };
    cache.remember(chat, entry.messages);

    // Devolve as mídias para o media-cache do número e religa no cache
    let mediaRestored = 0;
    const mediaDir = path.join(accountDataDir(row), 'media-cache');
    for (const message of entry.messages) {
      if (!message.mediaFile) continue;
      const src = entry.mediaPath(message.mediaFile);
      if (!fs.existsSync(src)) continue;
      try {
        fs.mkdirSync(mediaDir, { recursive: true });
        const dst = path.join(mediaDir, message.mediaFile);
        if (!fs.existsSync(dst)) fs.copyFileSync(src, dst);
        cache.attachFile(accountId, message.id, { path: dst, mimetype: message.mimetype, filename: message.filename });
        mediaRestored += 1;
      } catch (error) { /* mídia fica só na lixeira */ }
    }

    const sent = [];
    const failed = [];
    if (toWhatsApp) {
      for (const message of [...entry.messages].sort((a, b) => a.timestamp - b.timestamp)) {
        const when = new Date((message.timestamp || 0) * 1000).toLocaleString('pt-BR');
        const who = message.authorLabel || message.author || (message.fromMe ? 'eu' : entry.chatName || 'contato');
        const header = `↩️ Restaurado · ${who} · ${when}`;
        try {
          if (message.mediaFile && fs.existsSync(entry.mediaPath(message.mediaFile))) {
            const buffer = fs.readFileSync(entry.mediaPath(message.mediaFile));
            const result = await sendMessage({
              accountId,
              chatId: entry.chatId,
              kind: 'file',
              text: message.body ? `${header}\n${message.body}` : header,
              file: { buffer, mimetype: message.mimetype || 'application/octet-stream', filename: message.filename || 'arquivo' },
            });
            sent.push(result.id || message.id);
          } else if (String(message.body || '').trim()) {
            const result = await sendMessage({ accountId, chatId: entry.chatId, kind: 'text', text: `${header}\n${message.body}` });
            sent.push(result.id || message.id);
          }
        } catch (error) {
          failed.push({ id: message.id, error: error.message || String(error) });
        }
      }
    }

    trash.markRestored(accountId, entryId);
    return {
      ok: true,
      restored: entry.messages.length,
      mediaRestored,
      sent: sent.length,
      failed,
    };
  }

  function destroyTrash(accountId, entryId) {
    if (!trash.destroy(accountId, entryId)) throw httpError('Entrada não encontrada na lixeira', 404);
    return { ok: true };
  }

  async function exportChats(chatIds, onProgress, accountIds = {}) {
    const exports = [];
    for (const chatId of chatIds) {
      const row = requireOwner(chatId, accountIds[chatId]);
      const part = await row.service.exportChats([chatId], onProgress);
      exports.push(...part);
    }
    return exports;
  }

  async function backupChats(chatIds, onProgress) {
    const tagged = await collectTagged();
    const threads = buildThreads(tagged);
    const wanted = new Set(chatIds || []);
    const selected = threads.filter((thread) => (
      wanted.has(thread.id)
      || wanted.has(thread.chatId)
      || (thread.accounts || []).some((item) => wanted.has(item.chatId))
    ));
    if (!selected.length) throw httpError('Nenhuma conversa selecionada', 400);
    return writeBackup({
      backupRoot,
      threads: selected,
      onProgress,
      loadThread: async (thread) => {
        const messages = [];
        let avatarBuffer = null;
        const seen = new Set();
        for (const link of thread.accounts) {
          const row = runtime.get(link.accountId);
          let batch = [];
          if (row && row.service.getStatus().status === 'ready') {
            const chat = tagChat(row, await row.service.getChat(link.chatId));
            batch = await row.service.listMessages(link.chatId, 2000);
            cache.remember(chat, batch.map((message) => ({
              ...message,
              accountId: row.id,
              accountLabel: row.label,
            })));
            if (!avatarBuffer) {
              try {
                const avatar = await row.service.getAvatar(link.chatId);
                if (typeof avatar === 'string' && fs.existsSync(avatar)) {
                  avatarBuffer = await fs.promises.readFile(avatar);
                } else if (avatar && avatar.buffer) avatarBuffer = avatar.buffer;
              } catch (error) { avatarBuffer = null; }
            }
          } else {
            batch = cache.messagesForThread(thread.id).filter((message) => (
              message.accountId === link.accountId && message.chatId === link.chatId
            ));
          }
          for (const message of batch) {
            if (seen.has(message.id)) continue;
            seen.add(message.id);
            messages.push({
              ...message,
              accountId: link.accountId,
              accountLabel: link.label,
              chatId: link.chatId,
            });
          }
        }
        messages.sort((a, b) => a.timestamp - b.timestamp);
        return {
          messages,
          avatarBuffer,
          loadMedia: async (message) => {
            const file = await getMediaFile(message.id, message.accountId);
            if (!file) return null;
            if (file.path) {
              return {
                data: await fs.promises.readFile(file.path),
                mimetype: file.mimetype,
                filename: file.filename,
              };
            }
            return { data: file.buffer, mimetype: file.mimetype, filename: file.filename };
          },
        };
      },
    });
  }

  function listBackups() {
    return listBackupFolders(backupRoot).map((item) => ({
      id: item.id,
      createdAt: item.createdAt,
      threads: item.threads,
    }));
  }

  function backupDir(id) {
    if (!/^[a-zA-Z0-9_-]+$/.test(String(id || ''))) return null;
    const dir = path.join(backupRoot, id);
    if (!fs.existsSync(dir)) return null;
    return resolveInside(backupRoot, dir);
  }

  function exportDir(chatId) {
    for (const row of runtime.values()) {
      const dir = row.service.exportDir(chatId);
      if (dir) return dir;
    }
    return null;
  }

  async function sendMessage(input) {
    const row = requireOwner(input.chatId, input.accountId);
    return row.service.sendMessage(input);
  }

  function ownerAccountId(chatId, accountId) {
    const row = ownerOf(chatId, accountId);
    return row ? row.id : null;
  }

  loadMeta();
  migrateLegacy();
  for (const record of meta) ensureRuntime(record);

  return {
    start,
    stop,
    getStatus,
    getQr,
    listAccounts: () => [...runtime.values()].map(accountStatus),
    createAccount,
    connectAccount,
    disconnectAccount,
    renameAccount,
    removeAccount,
    listChats,
    getChat,
    listMessages,
    getThread,
    search,
    getAvatar,
    getMediaFile,
    deleteMessages,
    exportChats,
    backupChats,
    listBackups,
    backupDir,
    backupRoot: () => backupRoot,
    exportDir,
    sendMessage,
    ownerAccountId,
    messageAccountIds,
    listTrash,
    restoreTrash,
    destroyTrash,
    cacheStats: () => cache.stats(),
  };
}

module.exports = { createHub };
