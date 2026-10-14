const { digitsOnly } = require('./files');
const { formatPhone } = require('./phone');

const PREVIEW_LABEL = {
  image: 'Imagem',
  video: 'Vídeo',
  audio: 'Áudio',
  ptt: 'Mensagem de voz',
  document: 'Documento',
  sticker: 'Figurinha',
  location: 'Localização',
  vcard: 'Contato',
};

function cleanPreview(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (PREVIEW_LABEL[text]) return PREVIEW_LABEL[text];
  if (!text || text.startsWith('/9j/') || text.startsWith('data:image')) return '';
  if (text.length > 180 && !/\s/.test(text)) return '';
  return text.slice(0, 180);
}

function toChatSummary(raw) {
  const isGroup = Boolean(raw && raw.isGroup);
  const digits = isGroup ? '' : digitsOnly(raw && raw.phone);
  const name = String((raw && raw.name) || digits || 'Sem nome');
  return {
    id: String((raw && raw.id) || ''),
    name,
    number: digits,
    numberLabel: isGroup ? 'Grupo' : formatPhone(digits),
    folderNumber: isGroup ? 'grupo' : (digits || 'sem-numero'),
    isGroup,
    unread: Number(raw && raw.unread) || 0,
    timestamp: Number(raw && raw.timestamp) || 0,
    preview: cleanPreview(raw && raw.preview),
  };
}

function toMessageSummary(raw) {
  if (!raw || !raw.id) return null;
  const author = digitsOnly(String(raw.author || '').split('@')[0]);
  const lat = Number(raw.lat);
  const lng = Number(raw.lng);
  const location = raw.type === 'location' && Number.isFinite(lat) && Number.isFinite(lng)
    ? { lat, lng, description: String(raw.loc || '') }
    : null;
  return {
    id: String(raw.id),
    body: String(raw.body || ''),
    type: String(raw.type || 'chat'),
    timestamp: Number(raw.t) || 0,
    fromMe: Boolean(raw.fromMe),
    author,
    authorLabel: author ? formatPhone(author) : '',
    hasMedia: Boolean(raw.hasMedia),
    filename: String(raw.filename || ''),
    mimetype: String(raw.mimetype || ''),
    quoted: String(raw.quoted || '').slice(0, 240),
    location,
  };
}

module.exports = { toChatSummary, toMessageSummary };
