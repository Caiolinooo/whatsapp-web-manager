const { digitsOnly } = require('./files');

function threadKey(chat) {
  if (!chat) return '';
  if (chat.isGroup) return `g:${chat.id}`;
  const digits = digitsOnly(chat.number);
  if (digits) return `p:${digits}`;
  return `c:${chat.accountId || 'x'}:${chat.id}`;
}

function buildThreads(chats) {
  const map = new Map();
  for (const chat of chats || []) {
    if (!chat || !chat.id) continue;
    const key = threadKey(chat);
    let row = map.get(key);
    if (!row) {
      row = {
        id: key,
        chatId: chat.id,
        name: chat.name || '',
        number: chat.number || '',
        numberLabel: chat.numberLabel || '',
        folderNumber: chat.folderNumber || '',
        isGroup: Boolean(chat.isGroup),
        timestamp: 0,
        preview: '',
        unread: 0,
        accountId: chat.accountId || '',
        accounts: [],
      };
      map.set(key, row);
    }
    const accountId = chat.accountId || '';
    if (!row.accounts.some((item) => item.accountId === accountId && item.chatId === chat.id)) {
      row.accounts.push({
        accountId,
        label: chat.accountLabel || '',
        chatId: chat.id,
      });
    }
    row.unread += Number(chat.unread) || 0;
    const stamp = Number(chat.timestamp) || 0;
    if (stamp >= row.timestamp) {
      row.timestamp = stamp;
      row.chatId = chat.id;
      row.accountId = accountId;
      if (chat.preview) row.preview = chat.preview;
      if (chat.name) row.name = chat.name;
      if (chat.numberLabel) row.numberLabel = chat.numberLabel;
      if (chat.number) row.number = chat.number;
      if (chat.folderNumber) row.folderNumber = chat.folderNumber;
    }
  }
  return [...map.values()].sort((a, b) => b.timestamp - a.timestamp);
}

function normalizeQuery(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase();
}

function matchThreads(threads, query, accountId) {
  const tokens = normalizeQuery(query).split(/[^a-z0-9]+/).filter((token) => token.length >= 2);
  return (threads || []).filter((thread) => {
    if (accountId && !(thread.accounts || []).some((item) => item.accountId === accountId)) return false;
    if (!tokens.length) return false;
    const hay = normalizeQuery([
      thread.name,
      thread.number,
      thread.numberLabel,
      thread.preview,
      ...(thread.accounts || []).map((item) => item.label),
    ].join(' '));
    return tokens.every((token) => hay.includes(token));
  });
}

module.exports = { threadKey, buildThreads, matchThreads, normalizeQuery };
