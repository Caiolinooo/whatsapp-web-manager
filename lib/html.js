const { SYSTEM_TYPES, typeLabel } = require('./labels');

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[char]));
}

function linkify(escaped) {
  return escaped.replace(/https?:\/\/[^\s<]+/g, (url) => (
    `<a href="${url}" target="_blank" rel="noreferrer">${url}</a>`
  ));
}

function formatTime(unixSeconds) {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function formatDay(unixSeconds) {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function dayKey(unixSeconds) {
  const date = new Date(Number(unixSeconds) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function mediaBlock(message, relativePath) {
  if (!message.hasMedia) return '';
  if (!relativePath) {
    return '<p class="missing">Mídia não disponível</p>';
  }
  const src = escapeHtml(relativePath);
  const name = escapeHtml(message.filename || 'Arquivo');
  if (message.type === 'image' || message.type === 'sticker') {
    const cls = message.type === 'sticker' ? 'sticker' : 'photo';
    return `<img class="${cls}" src="${src}" alt="${name}">`;
  }
  if (message.type === 'video') {
    return `<video class="video" controls src="${src}"></video>`;
  }
  if (message.type === 'audio' || message.type === 'ptt') {
    return `<audio class="audio" controls src="${src}"></audio>`;
  }
  return `<a class="file" href="${src}" download="${name}"><span class="file-name">${name}</span><span class="file-kind">Arquivo</span></a>`;
}

function locationBlock(message) {
  if (!message.location || message.location.lat == null) return '';
  const lat = Number(message.location.lat);
  const lng = Number(message.location.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return '';
  const href = `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}#map=16/${lat}/${lng}`;
  const label = escapeHtml(message.location.description || 'Localização');
  return `<a class="location" href="${href}" target="_blank" rel="noreferrer">${label}</a>`;
}

function buildConversationHtml(model) {
  const name = model.chat.name || 'Conversa';
  const number = model.chat.numberLabel || (model.chat.isGroup ? 'Grupo' : '');
  const avatar = model.avatarFile
    ? `<img class="avatar" src="${escapeHtml(model.avatarFile)}" alt="">`
    : `<div class="avatar fallback">${escapeHtml(name.slice(0, 1).toUpperCase() || '?')}</div>`;

  const parts = [];
  let lastDay = '';
  const ordered = [...(model.messages || [])].sort((a, b) => a.timestamp - b.timestamp);
  for (const message of ordered) {
    const key = dayKey(message.timestamp);
    if (key && key !== lastDay) {
      parts.push(`<div class="day">${escapeHtml(formatDay(message.timestamp))}</div>`);
      lastDay = key;
    }
    if (SYSTEM_TYPES.has(message.type)) {
      const label = message.body || typeLabel(message.type) || 'Aviso';
      parts.push(`<div class="system">${linkify(escapeHtml(label))}</div>`);
      continue;
    }
    const side = message.fromMe ? 'out' : 'in';
    const author = !message.fromMe && message.authorLabel
      ? `<div class="author">${escapeHtml(message.authorLabel)}</div>`
      : '';
    const via = message.accountLabel
      ? `<div class="via">${escapeHtml(message.accountLabel)}</div>`
      : '';
    const quoted = message.quoted
      ? `<div class="quoted">${linkify(escapeHtml(message.quoted))}</div>`
      : '';
    const text = message.body
      ? `<p class="text">${linkify(escapeHtml(message.body))}</p>`
      : '';
    const media = mediaBlock(message, model.mediaMap?.[message.id] || '');
    const where = locationBlock(message);
    parts.push(
      `<div class="msg ${side}"><div class="bubble">${via}${author}${quoted}${media}${where}${text}<span class="time">${escapeHtml(formatTime(message.timestamp))}</span></div></div>`
    );
  }

  return `<!DOCTYPE html>
<html lang="pt-BR">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} ${escapeHtml(number)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin: 0; background: #0b141a; color: #e9edef; font-family: "Segoe UI", Helvetica, Arial, sans-serif; }
  header { display: flex; gap: 12px; align-items: center; padding: 10px 16px; background: #202c33; position: sticky; top: 0; }
  .avatar { width: 40px; height: 40px; border-radius: 50%; object-fit: cover; background: #6b7c85; }
  .avatar.fallback { display: grid; place-items: center; font-weight: 600; }
  h1 { font-size: 16px; margin: 0; font-weight: 500; }
  .sub { color: #8696a0; font-size: 13px; margin-top: 2px; }
  main { min-height: calc(100vh - 64px); padding: 16px 7% 28px; background-color: #0b141a; background-image: radial-gradient(rgba(255,255,255,.035) 1px, transparent 1px); background-size: 18px 18px; }
  .day, .system { width: fit-content; margin: 12px auto; background: #182229; color: #8696a0; font-size: 12px; padding: 6px 10px; border-radius: 8px; }
  .msg { display: flex; margin: 2px 0; }
  .msg.in { justify-content: flex-start; }
  .msg.out { justify-content: flex-end; }
  .bubble { max-width: min(65%, 520px); padding: 6px 8px 4px; border-radius: 8px; position: relative; }
  .msg.in .bubble { background: #202c33; border-top-left-radius: 0; }
  .msg.out .bubble { background: #005c4b; border-top-right-radius: 0; }
  .author, .via { color: #06cf9c; font-size: 13px; font-weight: 600; margin-bottom: 2px; }
  .via { color: #8696a0; font-weight: 550; font-size: 11px; }
  .quoted { border-left: 3px solid #06cf9c; background: rgba(0,0,0,.18); padding: 4px 8px; margin-bottom: 4px; font-size: 13px; color: #d1d7db; }
  .text { margin: 0; white-space: pre-wrap; word-break: break-word; font-size: 14.2px; line-height: 1.35; }
  .time { display: block; text-align: right; color: rgba(255,255,255,.6); font-size: 11px; margin-top: 2px; }
  img.photo, video.video { max-width: 100%; border-radius: 6px; display: block; }
  img.sticker { width: 160px; background: transparent; }
  .msg .bubble:has(.sticker) { background: transparent; }
  audio { width: 240px; }
  a { color: #53bdeb; }
  .file { display: flex; flex-direction: column; text-decoration: none; background: rgba(0,0,0,.15); padding: 8px; border-radius: 6px; min-width: 180px; }
  .file-name { color: #e9edef; }
  .file-kind, .missing { color: #8696a0; font-size: 12px; }
  .location { display: inline-block; margin-bottom: 4px; }
</style>
</head>
<body>
<header>
  ${avatar}
  <div>
    <h1>${escapeHtml(name)}</h1>
    <div class="sub">${escapeHtml(number || (model.chat.isGroup ? 'Grupo' : ''))}</div>
  </div>
</header>
<main>
${parts.join('\n')}
</main>
</body>
</html>
`;
}

module.exports = { buildConversationHtml, escapeHtml };
