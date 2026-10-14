const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeStructuredExport } = require('../lib/export');
const { formatPhone } = require('../lib/phone');
const { createCache } = require('../lib/cache');
const { writeBackup, listBackupFolders } = require('../lib/backup');
const { buildThreads, matchThreads, threadKey } = require('../lib/threads');
const { resolveInside } = require('../lib/files');

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);
const TINY_PDF = Buffer.from('%PDF-1.1\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n', 'utf8');

function textMessage(id, body, step, fromMe) {
  return {
    id,
    body,
    type: 'chat',
    timestamp: 1760000000 + step * 60,
    fromMe,
    author: '',
    authorLabel: '',
    hasMedia: false,
    filename: '',
    mimetype: '',
    quoted: '',
    location: null,
  };
}

function createDemoService({ exportRoot, io }) {
  fs.mkdirSync(exportRoot, { recursive: true });
  const backupsDir = path.join(exportRoot, 'backups');
  const cache = createCache(path.join(exportRoot, '.cache'));
  const lastExport = new Map();
  const chats = [
    {
      id: 'c1',
      name: 'Maria Silva',
      number: '5511987654321',
      numberLabel: formatPhone('5511987654321'),
      folderNumber: '5511987654321',
      isGroup: false,
      unread: 1,
      timestamp: 1760000600,
    },
    {
      id: 'c2',
      name: 'João Souza',
      number: '5521999887766',
      numberLabel: formatPhone('5521999887766'),
      folderNumber: '5521999887766',
      isGroup: false,
      unread: 0,
      timestamp: 1750000000,
    },
    {
      id: 'c3',
      name: 'Família',
      number: '',
      numberLabel: 'Grupo',
      folderNumber: 'grupo',
      isGroup: true,
      unread: 0,
      timestamp: 1740000000,
    },
  ];
  const store = {
    c1: [
      textMessage('m1', 'Primeira', 1, true),
      textMessage('m2', 'Segunda', 2, false),
      textMessage('m3', 'Terceira', 3, true),
      textMessage('m4', 'Quarta', 4, false),
      textMessage('m5', 'Quinta', 5, true),
      textMessage('m6', 'Sexta', 6, false),
      textMessage('m7', 'Sétima', 7, true),
      textMessage('m8', 'Oitava', 8, false),
      {
        ...textMessage('m9', 'foto da obra', 9, true),
        type: 'image',
        hasMedia: true,
        filename: 'foto.png',
        mimetype: 'image/png',
      },
      {
        ...textMessage('m10', 'segue o contrato', 10, true),
        type: 'document',
        hasMedia: true,
        filename: 'contrato.pdf',
        mimetype: 'application/pdf',
      },
    ],
    c2: [
      textMessage('j1', 'Oi', 1, false),
      textMessage('j2', 'Tudo bem?', 2, true),
    ],
    c3: [
      {
        ...textMessage('g1', 'Bom dia', 1, false),
        authorLabel: '+55 11 91234-5678',
      },
      textMessage('g2', 'Olá', 2, true),
    ],
  };
  const media = {
    m9: { data: TINY_PNG, mimetype: 'image/png', filename: 'foto.png' },
    m10: { data: TINY_PDF, mimetype: 'application/pdf', filename: 'contrato.pdf' },
  };
  const state = {
    status: 'ready',
    error: null,
    demo: true,
    percent: null,
    me: { name: 'Demonstração', number: '+55 11 90000-0000' },
  };

  function previewOf(chatId) {
    const list = store[chatId] || [];
    const last = list[list.length - 1];
    return last ? (last.body || last.type) : '';
  }

  function chatOrThrow(chatId) {
    const chat = chats.find((item) => item.id === chatId);
    if (!chat) {
      const error = new Error('Conversa não encontrada');
      error.status = 404;
      throw error;
    }
    return tagged(chat);
  }

  function tagged(chat) {
    const row = {
      ...chat,
      preview: previewOf(chat.id),
      accountId: 'demo',
      accountLabel: 'Demonstração',
    };
    return {
      ...row,
      threadId: threadKey(row),
      accounts: [{ accountId: 'demo', label: 'Demonstração', chatId: chat.id }],
    };
  }

  function syncCache() {
    for (const chat of chats) cache.remember(tagged(chat), store[chat.id] || []);
  }

  syncCache();

  return {
    async start() {
      io.emit('status', state);
    },
    async stop() {},
    getStatus() {
      return { ...state, hasQr: false };
    },
    getQr() {
      return null;
    },
    async listChats() {
      return chats
        .map((chat) => tagged(chat))
        .sort((a, b) => b.timestamp - a.timestamp);
    },
    async getChat(chatId) {
      return chatOrThrow(chatId);
    },
    async listMessages(chatId, limit) {
      chatOrThrow(chatId);
      const cap = Math.min(Math.max(Number(limit) || 40, 1), 5000);
      return (store[chatId] || []).slice(-cap);
    },
    async getThread(id, limit) {
      const threads = buildThreads(chats.map((chat) => tagged(chat)));
      const thread = threads.find((item) => item.id === id || item.chatId === id);
      if (!thread) {
        const error = new Error('Conversa não encontrada');
        error.status = 404;
        throw error;
      }
      const cap = Math.min(Math.max(Number(limit) || 80, 1), 5000);
      const row = tagged(chats.find((chat) => chat.id === thread.chatId));
      return {
        thread: { ...row, threadId: thread.id, accounts: thread.accounts },
        messages: cache.messagesForThread(thread.id).slice(-cap),
      };
    },
    search(query, options = {}) {
      const kind = options.kind || 'messages';
      if (kind === 'chats') {
        const threads = buildThreads(chats.map((chat) => tagged(chat)));
        return matchThreads(threads, query, options.accountId || '').slice(0, 80);
      }
      return cache.search(query, options);
    },
    cacheStats() {
      return cache.stats();
    },
    async sendMessage(input) {
      const chat = chatOrThrow(input.chatId);
      const kind = String(input.kind || 'text');
      const text = String(input.text || '');
      if (kind === 'text' && !text.trim()) {
        const error = new Error('Escreva uma mensagem');
        error.status = 400;
        throw error;
      }
      const id = `s${crypto.randomBytes(4).toString('hex')}`;
      const message = {
        id,
        body: text,
        type: kind === 'text' ? 'chat' : kind,
        timestamp: Math.floor(Date.now() / 1000),
        fromMe: true,
        author: '',
        authorLabel: '',
        hasMedia: Boolean(input.file && input.file.buffer && input.file.buffer.length),
        filename: input.file ? input.file.filename || '' : '',
        mimetype: input.file ? input.file.mimetype || '' : '',
        quoted: '',
        location: kind === 'location' ? { lat: Number(input.lat), lng: Number(input.lng), description: String(input.description || '') } : null,
        accountId: 'demo',
        accountLabel: 'Demonstração',
      };
      if (message.hasMedia) {
        media[id] = {
          data: input.file.buffer,
          mimetype: message.mimetype,
          filename: message.filename,
        };
      }
      store[chat.id].push(message);
      cache.remember(tagged(chat), [message]);
      const summary = chats.find((item) => item.id === chat.id);
      if (summary) summary.timestamp = message.timestamp;
      return { ok: true, id, chat: tagged(chat), message };
    },
    async getAvatar(chatId) {
      if (chatId !== 'c1' && chatId !== 'c3') return null;
      return { buffer: TINY_PNG, mimetype: 'image/png' };
    },
    async getMediaFile(messageId) {
      const item = media[messageId];
      if (!item) return null;
      return { buffer: item.data, mimetype: item.mimetype, filename: item.filename };
    },
    async deleteMessages(ids) {
      const pending = new Set(ids);
      const deleted = [];
      for (const chatId of Object.keys(store)) {
        store[chatId] = store[chatId].filter((message) => {
          if (!pending.has(message.id)) return true;
          pending.delete(message.id);
          deleted.push(message.id);
          return false;
        });
      }
      cache.forgetMessages(deleted);
      const failed = [...pending].map((id) => ({ id, error: 'Mensagem não encontrada' }));
      return { deleted, failed };
    },
    listTrash() {
      return [];
    },
    async restoreTrash() {
      throw Object.assign(new Error('Lixeira indisponível na demonstração'), { status: 400 });
    },
    async destroyTrash() {
      throw Object.assign(new Error('Lixeira indisponível na demonstração'), { status: 400 });
    },
    async exportChats(chatIds, onProgress) {
      const exports = [];
      for (const chatId of chatIds) {
        const chat = chatOrThrow(chatId);
        const result = await writeStructuredExport({
          exportRoot,
          chat,
          messages: store[chatId] || [],
          avatarBuffer: chatId === 'c1' ? TINY_PNG : null,
          loadMedia: async (message) => media[message.id] || null,
          onFile: onProgress,
        });
        lastExport.set(chatId, result.dir);
        exports.push(result);
      }
      return exports;
    },
    exportDir(chatId) {
      return lastExport.get(chatId) || null;
    },
    backupRoot() {
      return backupsDir;
    },
    backupDir(id) {
      if (!/^[a-zA-Z0-9_-]+$/.test(String(id || ''))) return null;
      const dir = path.join(backupsDir, id);
      if (!fs.existsSync(dir)) return null;
      return resolveInside(backupsDir, dir);
    },
    listBackups() {
      return listBackupFolders(backupsDir).map((item) => ({
        id: item.id,
        createdAt: item.createdAt,
        threads: item.threads,
      }));
    },
    async backupChats(chatIds, onProgress) {
      const threads = buildThreads(chats.map((chat) => tagged(chat)));
      const wanted = new Set(chatIds || []);
      const selected = threads.filter((thread) => (
        wanted.has(thread.id)
        || wanted.has(thread.chatId)
        || thread.accounts.some((item) => wanted.has(item.chatId))
      ));
      if (!selected.length) {
        const error = new Error('Nenhuma conversa selecionada');
        error.status = 400;
        throw error;
      }
      return writeBackup({
        backupRoot: backupsDir,
        threads: selected,
        onProgress,
        loadThread: async (thread) => {
          const messages = [];
          for (const link of thread.accounts) {
            for (const message of store[link.chatId] || []) {
              messages.push({
                ...message,
                accountId: 'demo',
                accountLabel: 'Demonstração',
                chatId: link.chatId,
              });
            }
          }
          messages.sort((a, b) => a.timestamp - b.timestamp);
          return {
            messages,
            avatarBuffer: thread.accounts.some((item) => item.chatId === 'c1') ? TINY_PNG : null,
            loadMedia: async (message) => {
              const item = media[message.id];
              if (!item) return null;
              return { data: item.data, mimetype: item.mimetype, filename: item.filename };
            },
          };
        },
      });
    },
  };
}

module.exports = { createDemoService, TINY_PNG };
