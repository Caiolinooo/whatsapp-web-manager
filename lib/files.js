const path = require('path');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

const MIME_EXT = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/3gpp': '3gp',
  'audio/ogg': 'ogg',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/opus': 'opus',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'text/plain': 'txt',
};

function sanitizeSegment(input) {
  let text = String(input ?? '')
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/g, '');
  if (!text || RESERVED.test(text)) text = 'item';
  return text.slice(0, 80);
}

function digitsOnly(value) {
  return String(value ?? '').replace(/\D/g, '');
}

function extensionFor(mimetype, filename) {
  const mime = String(mimetype || '').toLowerCase().split(';')[0].trim();
  if (MIME_EXT[mime]) return MIME_EXT[mime];
  if (filename && path.extname(filename)) {
    return path.extname(filename).replace('.', '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
  }
  const sub = mime.split('/')[1] || 'bin';
  return sub.replace(/[^a-z0-9]/g, '').slice(0, 8) || 'bin';
}

function mediaKind(mimetype, type) {
  const mime = String(mimetype || '').toLowerCase();
  const kind = String(type || '').toLowerCase();
  if (kind === 'sticker') return 'figurinhas';
  if (kind === 'image' || mime.startsWith('image/')) return 'imagens';
  if (kind === 'video' || mime.startsWith('video/')) return 'videos';
  if (kind === 'audio' || kind === 'ptt' || mime.startsWith('audio/')) return 'audios';
  if (kind === 'document' || mime.startsWith('application/') || mime.startsWith('text/')) return 'documentos';
  return 'outros';
}

function safeFilename(original, fallbackStem, ext) {
  const parsed = original ? path.parse(String(original)).name : '';
  const stem = sanitizeSegment(parsed || fallbackStem || 'arquivo');
  const cleanExt = String(ext || 'bin').replace(/[^a-z0-9]/gi, '').slice(0, 8) || 'bin';
  return `${stem}.${cleanExt}`;
}

function resolveInside(root, target) {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(target);
  const rel = path.relative(resolvedRoot, resolved);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    if (resolved !== resolvedRoot) return null;
  }
  return resolved;
}

function stampFromUnix(unixSeconds) {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return 'sem-data';
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

module.exports = {
  sanitizeSegment,
  digitsOnly,
  extensionFor,
  mediaKind,
  safeFilename,
  resolveInside,
  stampFromUnix,
};
