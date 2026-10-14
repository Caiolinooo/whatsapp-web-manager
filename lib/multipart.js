function readMultipart(req, maxBytes = 80 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    req.on('data', (chunk) => {
      if (failed) return;
      size += chunk.length;
      if (size > maxBytes) {
        failed = true;
        const error = new Error('Arquivo passa de 80 MB');
        error.status = 413;
        reject(error);
        req.pause();
        return;
      }
      chunks.push(chunk);
    });
    req.on('error', (error) => {
      if (!failed) reject(error);
    });
    req.on('end', () => {
      if (failed) return;
      try {
        resolve(parseMultipart(Buffer.concat(chunks), req.headers['content-type'] || ''));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function parseMultipart(buffer, contentType) {
  const match = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!match) {
    const error = new Error('Formulário inválido');
    error.status = 400;
    throw error;
  }
  const boundary = Buffer.from(`--${(match[1] || match[2]).trim()}`);
  const fields = {};
  let file = null;
  let start = buffer.indexOf(boundary);
  if (start < 0) {
    const error = new Error('Formulário inválido');
    error.status = 400;
    throw error;
  }
  while (start >= 0) {
    let partStart = start + boundary.length;
    if (buffer[partStart] === 45 && buffer[partStart + 1] === 45) break;
    if (buffer[partStart] === 13 && buffer[partStart + 1] === 10) partStart += 2;
    else if (buffer[partStart] === 10) partStart += 1;
    const next = buffer.indexOf(boundary, partStart);
    if (next < 0) break;
    let partEnd = next;
    if (partEnd >= 2 && buffer[partEnd - 2] === 13 && buffer[partEnd - 1] === 10) partEnd -= 2;
    else if (partEnd >= 1 && buffer[partEnd - 1] === 10) partEnd -= 1;
    const part = buffer.subarray(partStart, partEnd);
    const sep = part.indexOf('\r\n\r\n');
    const sepNl = sep >= 0 ? sep : part.indexOf('\n\n');
    const sepLen = sep >= 0 ? 4 : 2;
    if (sepNl >= 0) {
      const header = part.subarray(0, sepNl).toString('utf8');
      const body = part.subarray(sepNl + sepLen);
      const nameMatch = /name="([^"]+)"/.exec(header);
      const fileMatch = /filename="([^"]*)"/.exec(header);
      const typeMatch = /content-type:\s*([^\r\n]+)/i.exec(header);
      const name = nameMatch ? nameMatch[1] : '';
      if (name === '__proto__' || name === 'constructor' || name === 'prototype') {
        start = next;
        continue;
      }
      if (name && fileMatch && fileMatch[1]) {
        file = {
          field: name,
          filename: pathName(fileMatch[1]),
          mimetype: typeMatch ? typeMatch[1].trim() : 'application/octet-stream',
          buffer: Buffer.from(body),
        };
      } else if (name) {
        fields[name] = body.toString('utf8');
      }
    }
    start = next;
  }
  return { fields, file };
}

function pathName(value) {
  return String(value || '').split(/[/\\]/).pop().slice(0, 180);
}

function inferKind(kind, file) {
  const asked = String(kind || '').toLowerCase();
  if (['image', 'video', 'audio', 'ptt', 'document', 'sticker', 'location', 'contact'].includes(asked)) {
    return asked;
  }
  if (!file) return 'text';
  const mime = String(file.mimetype || '').toLowerCase();
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

module.exports = { readMultipart, parseMultipart, inferKind };
