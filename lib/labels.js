const TYPE_LABEL = {
  image: 'Imagem',
  video: 'Vídeo',
  audio: 'Áudio',
  ptt: 'Mensagem de voz',
  document: 'Documento',
  sticker: 'Figurinha',
  location: 'Localização',
  vcard: 'Contato',
  revoked: 'Mensagem apagada',
  poll_creation: 'Enquete',
  ciphertext: 'Mensagem criptografada',
};

const SYSTEM_TYPES = new Set([
  'e2e_notification',
  'notification',
  'gp2',
  'ciphertext',
  'revoked',
  'protocol',
  'call_log',
]);

function typeLabel(type) {
  return TYPE_LABEL[type] || '';
}

function previewText(message) {
  if (message.body) return message.body;
  return typeLabel(message.type) || '';
}

module.exports = { TYPE_LABEL, SYSTEM_TYPES, typeLabel, previewText };
