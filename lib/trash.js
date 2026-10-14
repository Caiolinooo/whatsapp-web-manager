// Lixeira/backup local: tudo que é apagado (pelo app ou no celular) vira uma
// entrada em data/trash/<conta>/<id>/ com meta.json + cópia das mídias.
// Assim dá para restaurar no projeto (cache) ou re-enviar ao WhatsApp depois.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    return null;
  }
}

function createTrash({ dir }) {
  fs.mkdirSync(dir, { recursive: true });

  function accountDir(accountId) {
    return path.join(dir, String(accountId || 'sem-conta'));
  }

  function metaPath(accountId, id) {
    return path.join(accountDir(accountId), String(id), 'meta.json');
  }

  // records: registros do cache (com filePath opcional apontando a mídia baixada)
  function archive({ accountId, accountLabel, chatId, chatName, isGroup, reason, records }) {
    const list = (records || []).filter(Boolean);
    if (!list.length) return null;
    const id = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const box = path.join(accountDir(accountId), id);
    fs.mkdirSync(box, { recursive: true });
    const messages = [];
    for (const record of list) {
      const item = {
        id: record.id,
        body: record.body || '',
        type: record.type || 'chat',
        timestamp: Number(record.timestamp) || 0,
        fromMe: Boolean(record.fromMe),
        author: record.author || '',
        authorLabel: record.authorLabel || '',
        hasMedia: Boolean(record.hasMedia),
        filename: record.filename || '',
        mimetype: record.mimetype || '',
        mediaFile: '',
      };
      if (record.filePath && fs.existsSync(record.filePath)) {
        const ext = path.extname(record.filePath) || '.bin';
        const name = `${crypto.createHash('sha1').update(String(record.id)).digest('hex')}${ext}`;
        try {
          fs.copyFileSync(record.filePath, path.join(box, name));
          item.mediaFile = name;
        } catch (error) { /* mídia some da lixeira, mas o texto fica */ }
      }
      messages.push(item);
    }
    const meta = {
      id,
      accountId: String(accountId || ''),
      accountLabel: String(accountLabel || ''),
      chatId: String(chatId || ''),
      chatName: String(chatName || ''),
      isGroup: Boolean(isGroup),
      reason: String(reason || 'deleted-app'), // deleted-app | revoked-phone
      deletedAt: Date.now(),
      restoredAt: 0,
      messages,
    };
    fs.writeFileSync(path.join(box, 'meta.json'), JSON.stringify(meta, null, 2));
    return meta;
  }

  function list(accountId) {
    const roots = accountId ? [accountDir(accountId)] : (fs.existsSync(dir) ? fs.readdirSync(dir).map((name) => path.join(dir, name)) : []);
    const out = [];
    for (const root of roots) {
      if (!fs.existsSync(root)) continue;
      for (const name of fs.readdirSync(root)) {
        const meta = readJson(path.join(root, name, 'meta.json'));
        if (meta) out.push(meta);
      }
    }
    out.sort((a, b) => b.deletedAt - a.deletedAt);
    return out;
  }

  function get(accountId, id) {
    const meta = readJson(metaPath(accountId, id));
    if (!meta) return null;
    const box = path.join(accountDir(accountId), meta.id);
    return {
      ...meta,
      mediaPath: (mediaFile) => (mediaFile ? path.join(box, mediaFile) : ''),
    };
  }

  function markRestored(accountId, id) {
    const meta = readJson(metaPath(accountId, id));
    if (!meta) return null;
    meta.restoredAt = Date.now();
    fs.writeFileSync(metaPath(accountId, id), JSON.stringify(meta, null, 2));
    return meta;
  }

  function destroy(accountId, id) {
    const box = path.join(accountDir(accountId), String(id));
    if (!readJson(path.join(box, 'meta.json'))) return false;
    fs.rmSync(box, { recursive: true, force: true });
    return true;
  }

  return { archive, list, get, markRestored, destroy };
}

module.exports = { createTrash };
