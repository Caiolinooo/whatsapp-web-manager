const { digitsOnly } = require('./files');

function formatPhone(value) {
  const digits = digitsOnly(value);
  if (!digits) return '';
  if (digits.startsWith('55') && (digits.length === 12 || digits.length === 13)) {
    const area = digits.slice(2, 4);
    const rest = digits.slice(4);
    if (rest.length === 9) return `+55 ${area} ${rest.slice(0, 5)}-${rest.slice(5)}`;
    if (rest.length === 8) return `+55 ${area} ${rest.slice(0, 4)}-${rest.slice(4)}`;
  }
  return `+${digits}`;
}

module.exports = { formatPhone };
