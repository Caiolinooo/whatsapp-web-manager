const fs = require('fs');
const path = require('path');
const { threadKey, normalizeQuery } = require('./threads');

const TYPE_WORDS = {
  image: 'imagem foto',
  video: 'video',
  gif: 'video gif',
  audio: 'audio',
  ptt: 'audio voz',
  document: 'documento arquivo',
  sticker: 'figurinha',
  location: 'localizacao mapa',
  vcard: 'contato agenda',
};

function tokenize(value) {
  const text = normalizeQuery(value);
  if (!text) return [];
  const out = [];
  const seen = new Set();
  for (const token of text.split(/[^a-z0-9]+/)) {
    if (token.length < 2 || token.length > 32 || seen.has(token)) continue;
    seen.add(token);
    out.push(token);
  }
  return out;
}

function plainText(value) {
  const text = String(value || '');
  if (text.length > 180 && !/\s/.test(text)) return '';
  return text.slice(0, 65000);
}

function messageKey(accountId, id) {
  return `${accountId || ''}\t${id}`;
}

function chatKey(accountId, id) {
  return `${accountId || ''}\t${id}`;
}

function createCache(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'store.json');
  const messages = new Map();
  const chats = new Map();
  const messageIndex = new Map();
  let timer = null;
  let writing = Promise.resolve();

  function tokensOfMessage(record) {
    return tokenize([
      plainText(record.body),
      record.filename,
      record.chatName,
      record.number,
      record.accountLabel,
      TYPE_WORDS[record.type] || '',
      record.mimetype,
    ].join(' '));
  }

  function addToIndex(record) {
    for (const token of tokensOfMessage(record)) {
      let set = messageIndex.get(token);
      if (!set) {
        set = new Set();
        messageIndex.set(token, set);
      }
      set.add(messageKey(record.accountId, record.id));
    }
  }

  function removeFromIndex(record) {
    for (const token of tokensOfMessage(record)) {
      const set = messageIndex.get(token);
      if (!set) continue;
      set.delete(messageKey(record.accountId, record.id));
      if (!set.size) messageIndex.delete(token);
    }
  }

  function load() {
    if (!fs.existsSync(file)) return;
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      for (const record of Object.values(parsed.messages || {})) {
        if (!record || !record.id) continue;
        messages.set(messageKey(record.accountId, record.id), record);
        addToIndex(record);
      }
      for (const record of Object.values(parsed.chats || {})) {
        if (!record || !record.id) continue;
        chats.set(chatKey(record.accountId, record.id), record);
      }
    } catch (error) {
      /* cache corrompido não impede o app de subir */
    }
  }

  function snapshot() {
    return {
      version: 1,
      messages: Object.fromEntries(messages),
      chats: Object.fromEntries(chats),
    };
  }

  function flush() {
    const payload = JSON.stringify(snapshot());
    writing = writing.then(async () => {
      const temp = `${file}.tmp`;
      await fs.promises.writeFile(temp, payload, 'utf8');
      await fs.promises.rename(temp, file);
    }).catch(() => {});
    return writing;
  }

  function scheduleFlush() {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      flush();
    }, 250);
  }

  function present(record) {
    const body = plainText(record.body);
    return {
      id: record.id,
      accountId: record.accountId || '',
      accountLabel: record.accountLabel || '',
      chatId: record.chatId || '',
      chatName: record.chatName || '',
      number: record.number || '',
      numberLabel: record.numberLabel || '',
      threadKey: record.threadKey || '',
      isGroup: Boolean(record.isGroup),
      body,
      snippet: body.replace(/\s+/g, ' ').trim().slice(0, 180),
      type: record.type || 'chat',
      timestamp: Number(record.timestamp) || 0,
      fromMe: Boolean(record.fromMe),
      hasMedia: Boolean(record.hasMedia),
      filename: record.filename || '',
      mimetype: record.mimetype || '',
    };
  }

  function upsertChat(chat) {
    if (!chat || !chat.id) return null;
    const record = {
      id: String(chat.id),
      name: String(chat.name || ''),
      number: String(chat.number || ''),
      numberLabel: String(chat.numberLabel || ''),
      folderNumber: String(chat.folderNumber || ''),
      isGroup: Boolean(chat.isGroup),
      timestamp: Number(chat.timestamp) || 0,
      preview: String(chat.preview || '').slice(0, 180),
      unread: Number(chat.unread) || 0,
      accountId: String(chat.accountId || ''),
      accountLabel: String(chat.accountLabel || ''),
      threadKey: threadKey(chat),
    };
    const key = chatKey(record.accountId, record.id);
    const prev = chats.get(key);
    if (prev && prev.timestamp > record.timestamp && !record.preview) {
      record.timestamp = prev.timestamp;
      record.preview = prev.preview;
    }
    chats.set(key, record);
    return record;
  }

  function upsertMessage(chat, message) {
    if (!chat || !message || !message.id) return null;
    const storedChat = upsertChat(chat);
    const key = messageKey(storedChat.accountId, message.id);
    const prev = messages.get(key);
    if (prev) removeFromIndex(prev);
    const record = {
      id: String(message.id),
      body: plainText(message.body),
      type: String(message.type || 'chat'),
      timestamp: Number(message.timestamp) || 0,
      fromMe: Boolean(message.fromMe),
      author: String(message.author || ''),
      authorLabel: String(message.authorLabel || ''),
      hasMedia: Boolean(message.hasMedia),
      filename: String(message.filename || '').slice(0, 240),
      mimetype: String(message.mimetype || ''),
      quoted: String(message.quoted || '').slice(0, 240),
      location: message.location || null,
      accountId: storedChat.accountId,
      accountLabel: storedChat.accountLabel,
      chatId: storedChat.id,
      chatName: storedChat.name,
      number: storedChat.number,
      numberLabel: storedChat.numberLabel,
      isGroup: storedChat.isGroup,
      threadKey: storedChat.threadKey,
      filePath: (prev && prev.filePath) || '',
      cachedAt: Date.now(),
    };
    messages.set(key, record);
    addToIndex(record);
    return record;
  }

  function remember(chat, list) {
    if (!chat) return;
    upsertChat(chat);
    for (const message of list || []) upsertMessage(chat, message);
    scheduleFlush();
  }

  function attachFile(accountId, messageId, file) {
    const record = messages.get(messageKey(accountId, messageId));
    if (!record || !file || !file.path) return;
    record.filePath = file.path;
    if (file.mimetype) record.mimetype = file.mimetype;
    if (file.filename) record.filename = file.filename;
    scheduleFlush();
  }

  function forgetMessages(ids) {
    const drop = new Set(ids || []);
    if (!drop.size) return;
    let changed = false;
    for (const [key, record] of messages) {
      if (!drop.has(record.id)) continue;
      removeFromIndex(record);
      messages.delete(key);
      changed = true;
    }
    if (changed) scheduleFlush();
  }

  function forgetAccount(accountId) {
    let changed = false;
    for (const [key, record] of messages) {
      if (record.accountId !== accountId) continue;
      removeFromIndex(record);
      messages.delete(key);
      changed = true;
    }
    for (const [key, record] of chats) {
      if (record.accountId !== accountId) continue;
      chats.delete(key);
      changed = true;
    }
    if (changed) scheduleFlush();
  }

  function idsFor(token) {
    const out = new Set();
    for (const [key, set] of messageIndex) {
      if (key === token || key.startsWith(token)) {
        for (const id of set) out.add(id);
      }
    }
    return out;
  }

  function search(query, options = {}) {
    const kind = options.kind || 'messages';
    const limit = Math.min(Math.max(Number(options.limit) || 80, 1), 200);
    const accountId = options.accountId || '';
    const tokens = tokenize(query);
    let rows = [];
    if (!tokens.length) {
      if (kind !== 'files') return [];
      rows = [...messages.values()].filter((record) => record.hasMedia);
    } else {
      let ids = null;
      for (const token of tokens) {
        const set = idsFor(token);
        ids = ids ? new Set([...ids].filter((id) => set.has(id))) : set;
        if (!ids.size) return [];
      }
      rows = [...ids].map((key) => messages.get(key)).filter(Boolean);
      if (kind === 'files') rows = rows.filter((record) => record.hasMedia);
    }
    if (accountId) rows = rows.filter((record) => record.accountId === accountId);
    rows.sort((a, b) => b.timestamp - a.timestamp);
    return rows.slice(0, limit).map(present);
  }

  function messagesForThread(key) {
    return [...messages.values()]
      .filter((record) => record.threadKey === key)
      .sort((a, b) => a.timestamp - b.timestamp)
      .map((record) => ({
        ...present(record),
        author: record.author || '',
        authorLabel: record.authorLabel || '',
        quoted: record.quoted || '',
        location: record.location || null,
      }));
  }

  function listChats() {
    return [...chats.values()];
  }

  function findMessage(id) {
    for (const record of messages.values()) {
      if (record.id === id) return record;
    }
    return null;
  }

  function stats() {
    let files = 0;
    for (const record of messages.values()) {
      if (record.hasMedia) files += 1;
    }
    return { messages: messages.size, files, chats: chats.size };
  }

  load();

  return {
    remember,
    attachFile,
    forgetMessages,
    forgetAccount,
    search,
    messagesForThread,
    listChats,
    findMessage,
    stats,
    flush,
    tokenize,
  };
}

module.exports = { createCache, tokenize };
