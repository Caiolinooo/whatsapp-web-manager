const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const ROOT = path.join(__dirname, '..');
// Com WHISPER_API_URL, transcreve via servidor OpenAI-compatível (ex.: faster-whisper na VM,
// que já aplica VAD + beam search e roda em GPU). Sem ele, cai no whisper-cli local.
const API_URL = String(process.env.WHISPER_API_URL || '').trim();
const API_KEY = String(process.env.WHISPER_API_KEY || '').trim();
const WHISPER_DIR = process.env.WHISPER_DIR || path.join(ROOT, 'bin', 'whisper');
const CLI = process.env.WHISPER_CLI || path.join(WHISPER_DIR, 'Release', 'whisper-cli.exe');
const MODEL = process.env.WHISPER_MODEL || path.join(WHISPER_DIR, 'ggml-small.bin');
const LANG = process.env.WHISPER_LANG || 'pt';
const TIMEOUT_MS = 5 * 60 * 1000;

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { timeout: TIMEOUT_MS, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const detail = String(stderr || stdout || error.message).slice(0, 400);
        return reject(new Error(detail));
      }
      resolve({ stdout, stderr });
    });
  });
}

function available() {
  return Boolean(API_URL) || (fs.existsSync(CLI) && fs.existsSync(MODEL));
}

async function transcribeRemote(buffer, mimetype) {
  const form = new FormData();
  form.append('file', new Blob([buffer], { type: mimetype || 'audio/ogg' }), `audio${extensionFor(mimetype)}`);
  form.append('language', LANG);
  const headers = {};
  if (API_KEY) headers.Authorization = `Bearer ${API_KEY}`;
  const response = await fetch(API_URL, {
    method: 'POST',
    headers,
    body: form,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(String(payload.detail || payload.error || `HTTP ${response.status}`).slice(0, 300));
  }
  return String(payload.text || '').replace(/\s+/g, ' ').trim();
}

function isAudio(mimetype) {
  return /^audio\//.test(String(mimetype || '')) || String(mimetype || '') === 'application/ogg';
}

function extensionFor(mimetype) {
  const mime = String(mimetype || 'audio/ogg').toLowerCase();
  if (mime.includes('ogg')) return '.ogg';
  if (mime.includes('mpeg') || mime.includes('mp3')) return '.mp3';
  if (mime.includes('mp4') || mime.includes('m4a') || mime.includes('aac')) return '.m4a';
  if (mime.includes('wav')) return '.wav';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('opus')) return '.opus';
  return '.bin';
}

function createTranscriber({ cacheDir }) {
  const transcriptsDir = path.join(cacheDir, 'transcripts');
  const tmpDir = path.join(cacheDir, 'transcripts-tmp');
  fs.mkdirSync(transcriptsDir, { recursive: true });
  fs.mkdirSync(tmpDir, { recursive: true });

  // v2: versões antigas geravam alucinações ("[MÚSICA]", repetições) que ficavam cacheadas
  function cachePath(key) {
    const safe = crypto.createHash('sha256').update(`v2|${String(key)}`).digest('hex');
    return path.join(transcriptsDir, `${safe}.txt`);
  }

  function cached(key) {
    const file = cachePath(key);
    if (!fs.existsSync(file)) return null;
    try {
      return fs.readFileSync(file, 'utf8');
    } catch (error) {
      return null;
    }
  }

  async function transcribe(key, buffer, mimetype) {
    if (!available()) {
      const error = new Error('Transcrição não instalada (bin/whisper)');
      error.status = 501;
      throw error;
    }
    if (!isAudio(mimetype)) {
      const error = new Error('Só é possível transcrever mensagens de áudio');
      error.status = 400;
      throw error;
    }
    const hit = cached(key);
    if (hit !== null) return { text: hit, cached: true };

    if (API_URL) {
      const text = await transcribeRemote(buffer, mimetype);
      fs.writeFileSync(cachePath(key), text);
      return { text, cached: false };
    }

    const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
    const input = path.join(tmpDir, `${stamp}${extensionFor(mimetype)}`);
    const wav = path.join(tmpDir, `${stamp}.wav`);
    const outBase = path.join(tmpDir, `${stamp}-out`);
    try {
      fs.writeFileSync(input, buffer);
      await run('ffmpeg', ['-y', '-i', input, '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav]);
      await run(CLI, ['-m', MODEL, '-f', wav, '-l', LANG, '-otxt', '--no-prints', '-of', outBase]);
      const text = fs.existsSync(`${outBase}.txt`)
        ? fs.readFileSync(`${outBase}.txt`, 'utf8').replace(/\s+/g, ' ').trim()
        : '';
      fs.writeFileSync(cachePath(key), text);
      return { text, cached: false };
    } finally {
      for (const file of [input, wav, `${outBase}.txt`]) {
        try { fs.rmSync(file, { force: true }); } catch (error) { /* temp */ }
      }
    }
  }

  return { available, transcribe };
}

module.exports = { createTranscriber };
