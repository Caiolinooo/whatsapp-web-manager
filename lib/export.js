const fs = require('fs');
const path = require('path');
const { buildConversationHtml } = require('./html');
const {
  sanitizeSegment,
  extensionFor,
  mediaKind,
  safeFilename,
  stampFromUnix,
} = require('./files');

function decodeBase64(data) {
  const clean = String(data || '').replace(/^data:[^;]+;base64,/, '');
  return Buffer.from(clean, 'base64');
}

async function writeStructuredExport({
  exportRoot,
  chat,
  messages,
  avatarBuffer,
  loadMedia,
  onFile,
}) {
  const nameDir = sanitizeSegment(chat.name || 'Sem nome');
  const numberDir = sanitizeSegment(chat.folderNumber || 'sem-numero');
  const dir = path.join(exportRoot, nameDir, numberDir);
  await fs.promises.mkdir(dir, { recursive: true });

  let avatarFile = '';
  if (avatarBuffer && avatarBuffer.length) {
    await fs.promises.writeFile(path.join(dir, 'avatar.jpg'), avatarBuffer);
    avatarFile = 'avatar.jpg';
  }

  const ordered = [...messages].sort((a, b) => a.timestamp - b.timestamp);
  const mediaMap = {};
  const files = [];
  const missing = [];
  const used = new Set();
  let index = 0;

  for (const message of ordered) {
    if (!message.hasMedia) continue;
    index += 1;
    let media = null;
    try {
      media = await loadMedia(message);
    } catch (error) {
      media = null;
      message.mediaError = error.message;
    }
    if (!media || !media.data) {
      missing.push(message.id);
      mediaMap[message.id] = '';
      continue;
    }
    const buffer = Buffer.isBuffer(media.data) ? media.data : decodeBase64(media.data);
    if (!buffer.length) {
      missing.push(message.id);
      mediaMap[message.id] = '';
      continue;
    }
    const kind = mediaKind(media.mimetype || message.mimetype, message.type);
    const ext = extensionFor(media.mimetype || message.mimetype, media.filename || message.filename);
    const stemFile = safeFilename(media.filename || message.filename, message.type || 'arquivo', ext);
    const dot = stemFile.lastIndexOf('.');
    const stem = dot > 0 ? stemFile.slice(0, dot) : stemFile;
    const fileExt = dot > 0 ? stemFile.slice(dot) : '';
    const prefix = `${stampFromUnix(message.timestamp)}_${index}`;
    let filename = `${prefix}_${stemFile}`;
    let copy = 2;
    while (used.has(`${kind}/${filename}`)) {
      filename = `${prefix}_${stem}_${copy}${fileExt}`;
      copy += 1;
    }
    used.add(`${kind}/${filename}`);
    const relative = `${kind}/${filename}`.replace(/\\/g, '/');
    await fs.promises.mkdir(path.join(dir, kind), { recursive: true });
    await fs.promises.writeFile(path.join(dir, kind, filename), buffer);
    mediaMap[message.id] = relative;
    files.push({ relativePath: relative, kind });
    if (onFile) onFile({ chatId: chat.id, name: chat.name, file: relative, index, total: ordered.length });
  }

  const html = buildConversationHtml({
    chat,
    messages: ordered,
    mediaMap,
    avatarFile,
  });
  const htmlPath = path.join(dir, 'conversa.html');
  await fs.promises.writeFile(htmlPath, html, 'utf8');

  return {
    chatId: chat.id,
    name: chat.name,
    dir,
    html: htmlPath,
    files: files.length,
    missing: missing.length,
    fileList: files,
  };
}

module.exports = { writeStructuredExport };
