const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { Client, LocalAuth, MessageMedia, Location } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { writeStructuredExport } = require('../lib/export');
const { extensionFor } = require('../lib/files');
const { formatPhone } = require('../lib/phone');
const { toChatSummary, toMessageSummary } = require('../lib/chats');

function findBrowser() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ].filter(Boolean);
  return candidates.find((item) => fs.existsSync(item));
}

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} excedeu ${Math.round(ms / 1000)}s`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

const SKIP_LIVE = new Set([
  'e2e_notification',
  'notification',
  'notification_template',
  'gp2',
  'protocol',
  'ciphertext',
]);

function createWaService({ dataDir, exportRoot, io, onLive, onRevoke }) {
  const sessionPath = path.join(dataDir, 'session');
  const avatarDir = path.join(dataDir, 'avatars');
  const mediaDir = path.join(dataDir, 'media-cache');
  for (const dir of [sessionPath, avatarDir, mediaDir, exportRoot]) {
    fs.mkdirSync(dir, { recursive: true });
  }

  let client = null;
  let starting = null;
  let qrDataUrl = null;
  let readyTimer = null;
  const lastExport = new Map();
  const mediaInflight = new Map();
  const avatarInflight = new Map();
  let avatarActive = 0;
  const avatarWait = [];
  const state = {
    status: 'idle',
    error: null,
    demo: false,
    percent: null,
    me: null,
  };

  function publish() {
    io.emit('status', { ...state });
  }

  function setStatus(status, extra = {}) {
    state.status = status;
    if (extra.percent !== undefined) state.percent = extra.percent;
    if (extra.me !== undefined) state.me = extra.me;
    state.error = extra.error || null;
    publish();
  }

  function requireReady() {
    if (state.status !== 'ready' || !client) {
      const error = new Error('WhatsApp ainda não está conectado');
      error.status = 409;
      throw error;
    }
  }

  async function destroyClient(current) {
    if (!current) return;
    try { await current.destroy(); } catch (error) { /* browser já fechou */ }
  }

  async function ensureClient() {
    if (client) return client;
    const executablePath = findBrowser();
    if (executablePath) console.log(`Navegador: ${executablePath}`);
    const puppeteer = {
      headless: process.env.HEADFUL === '1' ? false : true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    };
    if (executablePath) puppeteer.executablePath = executablePath;
    client = new Client({
      authStrategy: new LocalAuth({ dataPath: sessionPath }),
      authTimeoutMs: 120000,
      takeoverOnConflict: true,
      takeoverTimeoutMs: 5000,
      deviceName: 'WhatsApp Manager',
      browserName: 'Chrome',
      puppeteer,
    });
    client.on('qr', async (qr) => {
      try {
        qrDataUrl = await QRCode.toDataURL(qr, { width: 280, margin: 1 });
        setStatus('qr', { percent: null });
        io.emit('qr', qrDataUrl);
      } catch (error) {
        setStatus('error', { error: error.message });
      }
    });
    client.on('authenticated', () => {
      qrDataUrl = null;
      setStatus('loading', { percent: state.percent });
    });
    client.on('auth_failure', (message) => {
      setStatus('error', { error: String(message || 'Falha na autenticação') });
    });
    client.on('loading_screen', (percent) => {
      if (state.status === 'ready') return;
      setStatus('loading', { percent });
    });
    client.on('ready', () => {
      const wid = client.info?.wid?.user || '';
      setStatus('ready', {
        percent: null,
        me: {
          name: client.info?.pushname || '',
          number: formatPhone(wid),
        },
      });
    });
    client.on('disconnected', (reason) => {
      qrDataUrl = null;
      setStatus('idle', {
        me: null,
        percent: null,
        error: reason ? `Desconectado: ${reason}` : null,
      });
    });
    client.on('message_create', (msg) => {
      ingestLive(msg).catch((error) => {
        console.error('CACHE', error.message || error);
      });
    });
    // Mensagem apagada no celular (para todos ou só para mim) → lixeira
    const revokeId = (msg, revoked) => {
      const source = revoked || msg;
      const idObj = (source && source.id) || {};
      return idObj._serialized || (typeof (source && source.id) === 'string' ? source.id : '');
    };
    client.on('message_revoke_everyone', (msg, revoked) => {
      const id = revokeId(msg, revoked);
      if (id && typeof onRevoke === 'function') onRevoke(id);
    });
    client.on('message_revoke_me', (msg) => {
      const id = revokeId(msg);
      if (id && typeof onRevoke === 'function') onRevoke(id);
    });
    return client;
  }

  async function ingestLive(msg) {
    if (!msg || SKIP_LIVE.has(msg.type)) return null;
    const idObj = msg.id || {};
    const messageId = idObj._serialized || (typeof msg.id === 'string' ? msg.id : '');
    if (!messageId) return null;
    let chatId = '';
    try {
      chatId = String((msg.fromMe ? msg.to : msg.from) || '');
    } catch (error) {
      chatId = '';
    }
    let name = '';
    let phone = '';
    let isGroup = chatId.endsWith('@g.us');
    try {
      const chat = await msg.getChat();
      chatId = (chat.id && chat.id._serialized) || chatId;
      isGroup = Boolean(chat.isGroup);
      name = chat.name || '';
      if (!isGroup) {
        const contact = await msg.getContact();
        name = (contact && (contact.name || contact.pushname)) || name;
        phone = (contact && contact.number) || '';
      }
    } catch (error) {
      if (!isGroup) phone = chatId.split('@')[0];
    }
    const summary = toChatSummary({
      id: chatId,
      name,
      phone,
      isGroup,
      timestamp: msg.timestamp,
      preview: msg.body || msg.type || '',
      unread: 0,
    });
    const message = toMessageSummary({
      id: messageId,
      body: msg.caption || msg.body || '',
      type: msg.type || 'chat',
      t: msg.timestamp,
      fromMe: Boolean(msg.fromMe),
      author: msg.author || '',
      hasMedia: Boolean(msg.hasMedia),
      filename: (msg._data && msg._data.filename) || '',
      mimetype: (msg._data && msg._data.mimetype) || '',
    });
    if (!summary.id || !message) return null;
    if (typeof onLive === 'function') onLive(summary, message);
    return { chat: summary, message };
  }

  async function toVoiceMedia(file) {
    // WA só aceita voice note em ogg/opus; MediaRecorder do Chrome gera webm → transcodifica
    const mime = String(file.mimetype || '');
    if (/audio\/(ogg|opus)/.test(mime) && !mime.includes('webm')) {
      return new MessageMedia('audio/ogg; codecs=opus', file.buffer.toString('base64'), 'audio.ogg');
    }
    const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const dir = path.join(mediaDir, 'ptt-tmp');
    fs.mkdirSync(dir, { recursive: true });
    const input = path.join(dir, `${stamp}.bin`);
    const output = path.join(dir, `${stamp}.ogg`);
    try {
      fs.writeFileSync(input, file.buffer);
      await new Promise((resolve, reject) => {
        execFile('ffmpeg', ['-y', '-i', input, '-ar', '48000', '-ac', '1', '-c:a', 'libopus', '-b:a', '64k', output],
          { timeout: 60000, windowsHide: true },
          (error, stdout, stderr) => error ? reject(new Error(String(stderr || error.message).slice(0, 300))) : resolve());
      });
      const buffer = fs.readFileSync(output);
      return new MessageMedia('audio/ogg; codecs=opus', buffer.toString('base64'), 'audio.ogg');
    } finally {
      try { fs.rmSync(input, { force: true }); } catch (error) { /* temp */ }
      try { fs.rmSync(output, { force: true }); } catch (error) { /* temp */ }
    }
  }

  async function sendMessage(input) {
    requireReady();
    const chatId = String(input.chatId || '');
    if (!chatId) {
      const error = new Error('Conversa ausente');
      error.status = 400;
      throw error;
    }
    const kind = String(input.kind || 'text');
    const text = String(input.text || '');
    let sent = null;
    if (kind === 'location') {
      const lat = Number(input.lat);
      const lng = Number(input.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
        const error = new Error('Localização inválida');
        error.status = 400;
        throw error;
      }
      sent = await client.sendMessage(chatId, new Location(lat, lng, String(input.description || '')));
    } else if (kind === 'contact') {
      const digits = String(input.contactPhone || '').replace(/\D/g, '');
      const contactName = String(input.contactName || '').trim();
      if (!digits || !contactName) {
        const error = new Error('Informe nome e telefone do contato');
        error.status = 400;
        throw error;
      }
      const vcard = [
        'BEGIN:VCARD',
        'VERSION:3.0',
        `FN:${contactName}`,
        `TEL;type=CELL;type=VOICE;waid=${digits}:${digits}`,
        'END:VCARD',
      ].join('\n');
      sent = await client.sendMessage(chatId, vcard, { parseVCards: true });
    } else if (input.file && input.file.buffer && input.file.buffer.length) {
      const media = kind === 'ptt'
        ? await toVoiceMedia(input.file)
        : new MessageMedia(
            input.file.mimetype || 'application/octet-stream',
            input.file.buffer.toString('base64'),
            input.file.filename || 'arquivo',
          );
      const options = {};
      if (text.trim()) options.caption = text;
      if (kind === 'ptt') options.sendAudioAsVoice = true;
      if (kind === 'sticker') options.sendMediaAsSticker = true;
      sent = await withTimeout(client.sendMessage(chatId, media, options), 120000, 'Envio');
    } else {
      if (!text.trim()) {
        const error = new Error('Escreva uma mensagem');
        error.status = 400;
        throw error;
      }
      sent = await withTimeout(client.sendMessage(chatId, text), 60000, 'Envio');
    }
    if (!sent) {
      throw new Error('O WhatsApp não confirmou o envio');
    }
    const live = await ingestLive(sent).catch(() => null);
    return { ok: true, id: live && live.message ? live.message.id : '', chat: live && live.chat, message: live && live.message };
  }

  async function promoteIfUsable() {
    if (state.status === 'ready' || !client || !client.pupPage) return;
    try {
      const me = await withTimeout(client.pupPage.evaluate(() => {
        if (!window.WWebJS || typeof window.require !== 'function') return null;
        const chats = window.require('WAWebCollections').Chat.getModelsArray();
        if (!chats || !chats.length) return null;
        const prefs = window.require('WAWebUserPrefsMeUser');
        const wid = prefs.getMaybeMePnUser() || prefs.getMaybeMeLidUser();
        const user = wid && (wid.user || String(wid._serialized || wid).split('@')[0]);
        if (!user) return null;
        const conn = window.require('WAWebConnModel').Conn;
        return { number: String(user), name: (conn && conn.pushname) || '' };
      }), 8000, 'Sessão');
      if (!me || !me.number || state.status === 'ready') return;
      setStatus('ready', {
        percent: null,
        me: { name: me.name || '', number: formatPhone(me.number) },
      });
    } catch (error) { /* a página ainda está abrindo */ }
  }

  function watchReady() {
    if (readyTimer) clearInterval(readyTimer);
    readyTimer = setInterval(() => {
      if (!client || state.status === 'ready' || state.status === 'idle' || state.status === 'error') {
        clearInterval(readyTimer);
        readyTimer = null;
        return;
      }
      if (state.status === 'qr') return;
      promoteIfUsable();
    }, 2000);
  }

  function start() {
    if (state.status === 'ready') return Promise.resolve();
    if (starting) return starting;
    starting = (async () => {
      setStatus('starting');
      const current = await ensureClient();
      watchReady();
      await current.initialize();
    })().catch(async (error) => {
      const failed = client;
      client = null;
      qrDataUrl = null;
      await destroyClient(failed);
      setStatus('error', { error: error.message || String(error), me: null, percent: null });
      throw error;
    }).finally(() => {
      starting = null;
    });
    return starting;
  }

  async function stop() {
    qrDataUrl = null;
    if (readyTimer) {
      clearInterval(readyTimer);
      readyTimer = null;
    }
    const current = client;
    client = null;
    if (!current) {
      setStatus('idle', { me: null, percent: null });
      return;
    }
    await withTimeout(current.logout().catch(() => {}), 5000, 'Sair').catch(() => {});
    await withTimeout(destroyClient(current), 10000, 'Fechar navegador').catch(() => {});
    setStatus('idle', { me: null, percent: null });
  }

  async function collectChats() {
    requireReady();
    const rows = await withTimeout(client.pupPage.evaluate(() => {
      const list = window.require('WAWebCollections').Chat.getModelsArray();
      let toPn = null;
      try { toPn = window.require('WAWebLidMigrationUtils').toPn; } catch (error) { toPn = null; }
      const out = [];
      for (const chat of list) {
        try {
          const id = chat.id && chat.id._serialized;
          if (!id || String(id).endsWith('@broadcast')) continue;
          const isGroup = Boolean(chat.groupMetadata) || (chat.id && chat.id.server === 'g.us');
          let phone = '';
          if (!isGroup) {
            const rawPhone = chat.contact && chat.contact.phoneNumber;
            const serialized = rawPhone && (rawPhone._serialized || (typeof rawPhone === 'string' ? rawPhone : ''));
            if (serialized) phone = String(serialized).split('@')[0];
            else if (chat.id && chat.id.server === 'c.us') phone = chat.id.user || '';
            else if (toPn) {
              try {
                const pn = toPn(chat.id);
                const pnId = pn && (pn._serialized || '');
                if (pn && (pn.server === 'c.us' || String(pnId).endsWith('@c.us'))) {
                  phone = pn.user || String(pnId).split('@')[0];
                }
              } catch (error) { phone = ''; }
            }
          }
          const contact = chat.contact;
          const contactName = contact && (contact.name || contact.pushname || contact.formattedName || '');
          const name = contactName || chat.formattedTitle || chat.name || phone || id;
          let preview = '';
          try {
            const msgs = chat.msgs && chat.msgs.getModelsArray ? chat.msgs.getModelsArray() : [];
            const last = msgs.length ? msgs[msgs.length - 1] : null;
            if (last) {
              const text = String(last.caption || last.body || '').trim();
              const junk = !text || text.startsWith('/9j/') || text.startsWith('data:image') || (text.length > 180 && !/\s/.test(text));
              preview = junk ? String(last.type && last.type !== 'chat' ? last.type : '') : text;
            }
          } catch (error) { preview = ''; }
          out.push({
            id: String(id),
            name: String(name || ''),
            phone: String(phone || ''),
            isGroup,
            unread: chat.unreadCount || 0,
            timestamp: chat.t || 0,
            preview: preview.slice(0, 180),
          });
        } catch (error) { /* uma conversa quebrada não esvazia a lista */ }
      }
      return out;
    }), 60000, 'Lista de conversas');
    return rows
      .map((row) => toChatSummary(row))
      .filter((chat) => chat.id)
      .sort((a, b) => b.timestamp - a.timestamp);
  }

  async function readOne(chatId) {
    const chats = await collectChats();
    const found = chats.find((chat) => chat.id === chatId);
    if (!found) {
      const error = new Error('Conversa não encontrada');
      error.status = 404;
      throw error;
    }
    return found;
  }

  async function collectMessages(chatId, limit) {
    requireReady();
    const cap = Math.min(Math.max(Number(limit) || 40, 1), 5000);
    const raw = await withTimeout(client.pupPage.evaluate(async (id, max) => {
      const chat = await window.WWebJS.getChat(id, { getAsModel: false });
      if (!chat) return { error: 'missing' };
      const keep = (message) => message && !message.isNotification;
      let msgs = [];
      try { msgs = chat.msgs.getModelsArray().filter(keep); } catch (error) { msgs = []; }
      let guard = 0;
      while (msgs.length < max && guard < 50) {
        guard += 1;
        let loaded = null;
        try {
          loaded = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
        } catch (error) {
          break;
        }
        if (!loaded || !loaded.length) break;
        msgs = loaded.filter(keep).concat(msgs);
      }
      msgs.sort((a, b) => ((a.t || 0) > (b.t || 0) ? 1 : -1));
      if (msgs.length > max) msgs = msgs.slice(msgs.length - max);
      const mediaTypes = { image: 1, video: 1, audio: 1, ptt: 1, document: 1, sticker: 1, gif: 1 };
      return msgs.map((message) => {
        try {
          const idObj = message.id || {};
          let messageId = '';
          try {
            const text = String(message.id || '');
            if (text.includes('_') && text.includes('@')) messageId = text;
          } catch (error) { messageId = ''; }
          if (!messageId && idObj._serialized) messageId = String(idObj._serialized);
          const participant = idObj.participant;
          const author = participant ? (participant._serialized || participant) : '';
          let quoted = '';
          try {
            const quotedMsg = message.quotedMsg;
            quoted = quotedMsg ? String(quotedMsg.caption || quotedMsg.body || '').slice(0, 240) : '';
          } catch (error) { quoted = ''; }
          const type = message.type || 'chat';
          return {
            id: messageId,
            body: String(message.caption || message.body || ''),
            type,
            t: message.t || 0,
            fromMe: Boolean(idObj.fromMe),
            author: String(author || ''),
            hasMedia: Boolean(message.directPath || message.mediaKey || message.isMedia || mediaTypes[type]),
            filename: String(message.filename || ''),
            mimetype: String(message.mimetype || ''),
            quoted,
            lat: typeof message.lat === 'number' ? message.lat : null,
            lng: typeof message.lng === 'number' ? message.lng : null,
            loc: String(message.loc || ''),
          };
        } catch (error) {
          return null;
        }
      }).filter(Boolean);
    }, chatId, cap), 180000, 'Mensagens');
    if (raw && raw.error === 'missing') {
      const error = new Error('Conversa não encontrada');
      error.status = 404;
      throw error;
    }
    return (raw || [])
      .map((row) => toMessageSummary(row))
      .filter(Boolean)
      .sort((a, b) => a.timestamp - b.timestamp);
  }

  async function listChats() {
    return collectChats();
  }

  async function listMessages(chatId, limit) {
    return collectMessages(chatId, limit);
  }

  function avatarFile(chatId) {
    const hash = crypto.createHash('sha1').update(String(chatId)).digest('hex');
    return path.join(avatarDir, `${hash}.jpg`);
  }

  async function loadAvatar(chatId) {
    const cached = avatarFile(chatId);
    if (fs.existsSync(cached)) return cached;
    requireReady();
    let url = '';
    try {
      url = await withTimeout(client.pupPage.evaluate(async (id) => {
        try {
          const chat = await window.WWebJS.getChat(id, { getAsModel: false });
          if (!chat) return '';
          const pic = await window.require('WAWebContactProfilePicThumbBridge').requestProfilePicFromServer(chat);
          return pic && pic.eurl ? String(pic.eurl) : '';
        } catch (error) {
          return '';
        }
      }, chatId), 15000, 'Foto');
    } catch (error) {
      url = '';
    }
    if (!url) return null;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (!buffer.length) return null;
    await fs.promises.writeFile(cached, buffer);
    return cached;
  }

  function getAvatar(chatId) {
    if (!chatId) return Promise.resolve(null);
    const cached = avatarFile(chatId);
    if (fs.existsSync(cached)) return Promise.resolve(cached);
    if (state.status !== 'ready') return Promise.resolve(null);
    if (avatarInflight.has(chatId)) return avatarInflight.get(chatId);
    const job = new Promise((resolve, reject) => {
      const run = () => {
        avatarActive += 1;
        loadAvatar(chatId).then(resolve, reject).finally(() => {
          avatarActive -= 1;
          const next = avatarWait.shift();
          if (next) next();
        });
      };
      if (avatarActive < 2) run();
      else avatarWait.push(run);
    }).finally(() => avatarInflight.delete(chatId));
    avatarInflight.set(chatId, job);
    return job;
  }

  async function downloadToCache(messageId) {
    const hash = crypto.createHash('sha1').update(String(messageId)).digest('hex');
    const metaPath = path.join(mediaDir, `${hash}.json`);
    if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8'));
      const full = path.join(mediaDir, meta.file);
      if (fs.existsSync(full)) {
        return { path: full, mimetype: meta.mimetype, filename: meta.filename };
      }
    }
    requireReady();
    const media = await withTimeout(client.pupPage.evaluate(async (messageId) => {
      const explain = (error) => {
        const message = error && error.message ? String(error.message) : String(error || 'Falha no download');
        const line = error && error.stack ? String(error.stack).split('\n')[1] : '';
        return line ? `${message} ${line.trim()}` : message;
      };
      try {
        const store = window.require('WAWebCollections');
        let msg = store.Msg.get(messageId);
        if (!msg) {
          const loaded = await store.Msg.getMessagesById([messageId]);
          msg = loaded && loaded.messages && loaded.messages[0];
        }
        if (!msg) return { missing: true };
        if (msg.mediaData && msg.mediaData.mediaStage === 'REUPLOADING') {
          return { error: 'Mídia expirada no WhatsApp' };
        }
        if (msg.mediaData && msg.mediaData.mediaStage && msg.mediaData.mediaStage !== 'RESOLVED') {
          try {
            await msg.downloadMedia({ downloadEvenIfExpensive: true, rmrReason: 1 });
          } catch (error) { /* tenta descriptografar mesmo assim */ }
        }
        const stage = msg.mediaData && msg.mediaData.mediaStage;
        if (stage && (String(stage).includes('ERROR') || stage === 'FETCHING')) {
          return { missing: true };
        }
        if (!msg.directPath || !msg.mediaKey) return { missing: true };
        const fallbackMime = {
          image: 'image/jpeg',
          sticker: 'image/webp',
          video: 'video/mp4',
          gif: 'video/mp4',
          audio: 'audio/ogg',
          ptt: 'audio/ogg',
        };
        let mimetype = msg.mimetype || (msg.mediaData && msg.mediaData.mimetype) || '';
        if (!mimetype || mimetype === 'application/octet-stream') {
          mimetype = fallbackMime[msg.type] || mimetype || 'application/octet-stream';
        }
        const mockQpl = {
          addAnnotations() { return this; },
          addPoint() { return this; },
        };
        const decrypted = await window.require('WAWebDownloadManager').downloadManager.downloadAndMaybeDecrypt({
          directPath: msg.directPath,
          encFilehash: msg.encFilehash,
          filehash: msg.filehash,
          mediaKey: msg.mediaKey,
          mediaKeyTimestamp: msg.mediaKeyTimestamp,
          mimetype,
          type: msg.type,
          signal: new AbortController().signal,
          downloadQpl: mockQpl,
        });
        const data = await window.WWebJS.arrayBufferToBase64Async(decrypted);
        if (!data) return { missing: true };
        return {
          data,
          mimetype: msg.mimetype || 'application/octet-stream',
          filename: msg.filename || '',
        };
      } catch (error) {
        if (error && error.status === 404) return { missing: true };
        return { error: explain(error) };
      }
    }, messageId), 90000, 'Download da mídia');
    if (!media || media.missing) return null;
    if (media.error) throw new Error(media.error);
    if (!media.data) return null;
    const ext = extensionFor(media.mimetype, media.filename);
    const file = `${hash}.${ext}`;
    const clean = String(media.data).replace(/^data:[^;]+;base64,/, '');
    await fs.promises.writeFile(path.join(mediaDir, file), Buffer.from(clean, 'base64'));
    const meta = {
      file,
      mimetype: media.mimetype || 'application/octet-stream',
      filename: media.filename || file,
    };
    await fs.promises.writeFile(metaPath, JSON.stringify(meta));
    return { path: path.join(mediaDir, file), mimetype: meta.mimetype, filename: meta.filename };
  }

  function getMediaFile(messageId) {
    if (!messageId) return Promise.resolve(null);
    if (mediaInflight.has(messageId)) return mediaInflight.get(messageId);
    const job = downloadToCache(messageId).finally(() => mediaInflight.delete(messageId));
    mediaInflight.set(messageId, job);
    return job;
  }

  async function deleteMessages(ids, everyone, onProgress) {
    requireReady();
    const deleted = [];
    const failed = [];
    for (let i = 0; i < ids.length; i += 1) {
      const id = ids[i];
      try {
        const result = await withTimeout(client.pupPage.evaluate(async (messageId, forEveryone) => {
          const explain = (error) => {
            const message = error && error.message ? String(error.message) : String(error || 'Falha ao excluir');
            const line = error && error.stack ? String(error.stack).split('\n')[1] : '';
            return line ? `${message} ${line.trim()}` : message;
          };
          try {
            const store = window.require('WAWebCollections');
            let msg = store.Msg.get(messageId);
            if (!msg) {
              const loaded = await store.Msg.getMessagesById([messageId]);
              msg = loaded && loaded.messages && loaded.messages[0];
            }
            if (!msg) return { ok: false, error: 'Mensagem não encontrada' };
            const remote = msg.id && msg.id.remote;
            let chat = remote ? store.Chat.get(remote) : null;
            if (!chat && remote) {
              try { chat = await store.Chat.find(remote); } catch (error) { chat = null; }
            }
            const { Cmd } = window.require('WAWebCmd');
            const modern = window.WWebJS.compareWwebVersions(window.Debug.VERSION, '>=', '2.3000.0');
            if (forEveryone) {
              const sent = await window.require('WAWebRevokeMsgAction').sendRevoke(
                { type: 'message', data: msg },
                msg.id && msg.id.fromMe ? 'Sender' : 'Admin',
                true,
              );
              const code = sent && sent.messageSendResult ? String(sent.messageSendResult) : '';
              if (code && code !== 'OK') {
                return { ok: false, error: 'O WhatsApp não deixa excluir esta mensagem para todos' };
              }
            } else if (!chat) {
              return { ok: false, error: 'Conversa não encontrada' };
            } else if (modern) {
              await Cmd.sendDeleteMsgs(chat, { list: [msg], type: 'message' }, true);
            } else {
              await Cmd.sendDeleteMsgs(chat, [msg], true);
            }
            const started = Date.now();
            while (Date.now() - started < 5000) {
              const again = store.Msg.get(messageId);
              const removed = !again || again.type === 'revoked' || again.isDeleted;
              if (removed) return { ok: true };
              await new Promise((resolve) => setTimeout(resolve, 200));
            }
            return { ok: false, error: 'O WhatsApp não confirmou a exclusão' };
          } catch (error) {
            return { ok: false, error: explain(error) };
          }
        }, id, Boolean(everyone)), 30000, 'Excluir');
        if (!result || !result.ok) throw new Error((result && result.error) || 'Falha ao excluir');
        deleted.push(id);
      } catch (error) {
        const message = error.message || String(error);
        failed.push({ id, error: message });
        console.error('DELETE', id, message);
      }
      if (onProgress) onProgress({ index: i + 1, total: ids.length });
      if (i < ids.length - 1) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    return { deleted, failed };
  }

  async function exportChats(chatIds, onProgress) {
    requireReady();
    const exports = [];
    for (const chatId of chatIds) {
      const summary = await readOne(chatId);
      const messages = await collectMessages(chatId, 2000);
      let avatarBuffer = null;
      try {
        const avatar = await getAvatar(chatId);
        if (typeof avatar === 'string' && fs.existsSync(avatar)) {
          avatarBuffer = await fs.promises.readFile(avatar);
        }
      } catch (error) {
        avatarBuffer = null;
      }
      const result = await writeStructuredExport({
        exportRoot,
        chat: summary,
        messages,
        avatarBuffer,
        loadMedia: async (message) => {
          const file = await getMediaFile(message.id);
          if (!file) return null;
          return {
            data: await fs.promises.readFile(file.path),
            mimetype: file.mimetype,
            filename: file.filename,
          };
        },
        onFile: onProgress,
      });
      lastExport.set(chatId, result.dir);
      exports.push(result);
    }
    return exports;
  }

  return {
    start,
    stop,
    getStatus: () => ({ ...state, hasQr: Boolean(qrDataUrl) }),
    getQr: () => qrDataUrl,
    listChats,
    getChat: readOne,
    listMessages,
    getAvatar,
    getMediaFile,
    deleteMessages,
    exportChats,
    sendMessage,
    exportDir: (chatId) => lastExport.get(chatId) || null,
  };
}

module.exports = { createWaService, findBrowser };
