const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { writeStructuredExport } = require('./export');
const { stampFromUnix } = require('./files');

async function writeBackup({ backupRoot, threads, loadThread, onProgress }) {
  const id = `${stampFromUnix(Date.now() / 1000)}-${crypto.randomBytes(3).toString('hex')}`;
  const root = path.join(backupRoot, id);
  await fs.promises.mkdir(root, { recursive: true });
  const saved = [];
  for (const thread of threads) {
    const loaded = await loadThread(thread);
    const messages = loaded.messages || [];
    const chat = {
      id: thread.id,
      name: thread.name || 'Conversa',
      numberLabel: thread.numberLabel || (thread.isGroup ? 'Grupo' : ''),
      folderNumber: thread.isGroup ? 'grupo' : (thread.number || thread.folderNumber || 'sem-numero'),
      isGroup: Boolean(thread.isGroup),
    };
    const result = await writeStructuredExport({
      exportRoot: root,
      chat,
      messages,
      avatarBuffer: loaded.avatarBuffer || null,
      loadMedia: loaded.loadMedia,
      onFile: onProgress,
    });
    const dump = messages.map((message) => ({
      id: message.id,
      accountId: message.accountId || '',
      accountLabel: message.accountLabel || '',
      chatId: message.chatId || '',
      fromMe: Boolean(message.fromMe),
      type: message.type || 'chat',
      timestamp: message.timestamp || 0,
      body: message.body || '',
      filename: message.filename || '',
      mimetype: message.mimetype || '',
      authorLabel: message.authorLabel || '',
    }));
    await fs.promises.writeFile(path.join(result.dir, 'mensagens.json'), JSON.stringify(dump, null, 2));
    saved.push({
      threadId: thread.id,
      name: result.name,
      dir: result.dir,
      html: result.html,
      files: result.files,
      missing: result.missing,
      messages: messages.length,
    });
  }
  const manifest = {
    id,
    createdAt: new Date().toISOString(),
    threads: saved.map((item) => ({
      threadId: item.threadId,
      name: item.name,
      messages: item.messages,
      files: item.files,
      missing: item.missing,
    })),
  };
  await fs.promises.writeFile(path.join(root, 'manifest.json'), JSON.stringify(manifest, null, 2));
  return { id, dir: root, threads: saved };
}

function listBackupFolders(backupRoot) {
  if (!fs.existsSync(backupRoot)) return [];
  const rows = [];
  for (const name of fs.readdirSync(backupRoot)) {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) continue;
    const dir = path.join(backupRoot, name);
    const manifestPath = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      rows.push({
        id: name,
        createdAt: manifest.createdAt || '',
        threads: Array.isArray(manifest.threads) ? manifest.threads : [],
        dir,
      });
    } catch (error) {
      /* pasta incompleta */
    }
  }
  rows.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return rows;
}

module.exports = { writeBackup, listBackupFolders };
