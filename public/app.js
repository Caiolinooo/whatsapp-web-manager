const state = {
  chats: [],
  query: '',
  accountId: '',
  selectedChats: new Set(),
  chatAnchor: null,
  openChatId: null,
  openThreadId: null,
  openChat: null,
  messages: [],
  selectedMsgs: new Set(),
  msgAnchor: null,
  limit: 40,
  busy: false,
  loaded: false,
  loadingChats: false,
  chatError: '',
  accountStamp: '',
  session: null,
  accounts: [],
};

const $ = (id) => document.getElementById(id);
const CONNECT_HELP = 'Abra o WhatsApp no celular, entre em Dispositivos conectados e escolha Conectar dispositivo. Se já existir outra sessão Web, esta conexão assume o lugar dela.';

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

async function api(url, options) {
  const response = await fetch(url, options);
  const isJson = (response.headers.get('content-type') || '').includes('json');
  const data = isJson ? await response.json() : null;
  if (!response.ok) throw new Error((data && data.error) || response.statusText);
  return data;
}

let toastTimer;
function toast(message) {
  const node = $('toast');
  node.textContent = message;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { node.hidden = true; }, 5000);
}

function accountLinks(chat) {
  if (chat.accounts && chat.accounts.length) return chat.accounts;
  return [{ accountId: chat.accountId || '', label: chat.accountLabel || '', chatId: chat.id }];
}

function visibleChats() {
  const query = state.query.trim().toLowerCase();
  return state.chats.filter((chat) => {
    if (state.accountId && !accountLinks(chat).some((link) => link.accountId === state.accountId)) return false;
    if (!query) return true;
    return chat.name.toLowerCase().includes(query)
      || String(chat.number || '').includes(query)
      || String(chat.numberLabel || '').toLowerCase().includes(query)
      || String(chat.accountLabel || '').toLowerCase().includes(query);
  });
}

function visibleChatIds() {
  return visibleChats().map((chat) => chat.id);
}

function messageIds() {
  return state.messages.map((message) => message.id);
}

function timeLabel(unix) {
  const date = new Date(Number(unix) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
}

function dayLabel(unix) {
  const date = new Date(Number(unix) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function dayKey(unix) {
  const date = new Date(Number(unix) * 1000);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

function initials(name) {
  const text = String(name || '?').trim();
  return (text.slice(0, 1) || '?').toUpperCase();
}

function avatarNode(chatId, name, accountId) {
  const wrap = el('div');
  const fallback = el('div', 'avatar-fallback', initials(name));
  const img = document.createElement('img');
  img.className = 'avatar';
  img.alt = '';
  const query = new URLSearchParams({ chatId: chatId || '' });
  if (accountId) query.set('accountId', accountId);
  img.src = `/api/avatar?${query}`;
  img.hidden = true;
  img.addEventListener('load', () => {
    if (img.naturalWidth > 0) {
      img.hidden = false;
      fallback.hidden = true;
    }
  });
  wrap.append(fallback, img);
  return wrap;
}

function selectionTargets(rows) {
  const chatIds = [];
  const accountIds = {};
  const threadIds = [];
  for (const row of rows) {
    if (row.threadId) threadIds.push(row.threadId);
    else threadIds.push(row.id);
    for (const link of accountLinks(row)) {
      if (!link.chatId || chatIds.includes(link.chatId)) continue;
      chatIds.push(link.chatId);
      if (link.accountId) accountIds[link.chatId] = link.accountId;
    }
  }
  return { chatIds, accountIds, threadIds };
}

function updateActions() {
  const total = state.chats.length;
  const chatCount = state.selectedChats.size;
  $('chat-count').textContent = state.loadingChats && !total
    ? 'Carregando conversas…'
    : (chatCount ? `${chatCount} selecionadas · ${total} conversas` : `${total} conversas`);
  $('export-selected').disabled = state.busy || chatCount === 0;
  $('backup-selected').disabled = state.busy || chatCount === 0;
  const msgCount = state.selectedMsgs.size;
  $('msg-count').textContent = msgCount ? `${msgCount} mensagens` : '';
  $('delete-messages').disabled = state.busy || msgCount === 0;
  $('delete-messages').textContent = msgCount ? `Excluir (${msgCount})` : 'Excluir';
  $('export-one').disabled = state.busy || !state.openChatId;
  $('backup-one').disabled = state.busy || !state.openChatId;
  $('load-more').disabled = state.busy || !state.openChatId;
  $('send-button').disabled = state.busy || !state.openChatId;
}

function renderAccountFilter() {
  const box = $('account-filter');
  const accounts = state.accounts.filter((item) => item.status === 'ready' || item.me);
  box.hidden = accounts.length < 2;
  box.replaceChildren();
  if (box.hidden) return;
  const all = el('button', 'chip', 'Todos');
  all.type = 'button';
  all.setAttribute('aria-pressed', state.accountId ? 'false' : 'true');
  all.addEventListener('click', () => {
    state.accountId = '';
    renderChats();
  });
  box.append(all);
  for (const account of accounts) {
    const chip = el('button', 'chip', account.label);
    chip.type = 'button';
    chip.setAttribute('aria-pressed', state.accountId === account.id ? 'true' : 'false');
    chip.addEventListener('click', () => {
      state.accountId = account.id;
      renderChats();
    });
    box.append(chip);
  }
}

function renderChatSelection() {
  for (const row of $('chats').querySelectorAll('[data-chat-id]')) {
    const on = state.selectedChats.has(row.dataset.chatId);
    if (on) row.dataset.selected = '1';
    else delete row.dataset.selected;
    row.classList.toggle('active', row.dataset.chatId === state.openChatId);
    const tick = row.querySelector('.tick');
    if (tick) tick.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  updateActions();
}

function renderChats() {
  const box = $('chats');
  const keep = box.scrollTop;
  box.replaceChildren();
  const visible = visibleChats();
  if (!visible.length) {
    const message = state.loadingChats
      ? 'Carregando conversas…'
      : (state.chatError || (state.query ? 'Nenhum resultado' : 'Nenhuma conversa'));
    box.append(el('p', 'empty-list', message));
  }
  for (const chat of visible) {
    const row = el('button', 'chat-row');
    row.type = 'button';
    row.dataset.chatId = chat.id;
    if (chat.id === state.openChatId) row.classList.add('active');
    if (state.selectedChats.has(chat.id)) row.dataset.selected = '1';
    const tick = el('span', 'tick');
    tick.setAttribute('aria-pressed', state.selectedChats.has(chat.id) ? 'true' : 'false');
    tick.setAttribute('aria-label', 'Selecionar conversa');
    const text = el('div');
    const who = el('div', 'who');
    const name = el('div', 'name', chat.name);
    if ((chat.accounts || []).length > 1 && chat.accountLabel) {
      name.append(el('span', 'account-pill', chat.accountLabel));
    }
    who.append(name, el('div', 'meta', chat.numberLabel || 'Grupo'));
    text.append(who, el('div', 'preview', chat.preview || ''));
    row.append(tick, avatarNode(chat.id, chat.name, chat.accountId), text);
    box.append(row);
  }
  box.scrollTop = keep;
  renderAccountFilter();
  updateActions();
}

function renderThread() {
  const empty = $('empty');
  const thread = $('thread');
  if (!state.openChat) {
    empty.hidden = false;
    thread.hidden = true;
    return;
  }
  empty.hidden = true;
  thread.hidden = false;
  const head = $('thread-head');
  head.replaceChildren(avatarNode(state.openChat.id, state.openChat.name, state.openChat.accountId));
  const info = el('div');
  const phone = state.openChat.numberLabel || 'Grupo';
  info.append(el('h2', '', state.openChat.name), el('p', '', phone));
  if ((state.openChat.accounts || []).length > 1 && state.openChat.accountLabel) {
    info.append(el('p', 'muted', state.openChat.accountLabel));
  }
  head.append(info);
  renderComposerAccounts();

  const box = $('messages');
  const stick = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  box.replaceChildren();
  let lastDay = '';
  const several = (state.openChat.accounts || []).length > 1;
  for (const message of state.messages) {
    const key = dayKey(message.timestamp);
    if (key && key !== lastDay) {
      box.append(el('div', 'day', dayLabel(message.timestamp)));
      lastDay = key;
    }
    const row = el('div', `msg-row ${message.fromMe ? 'out' : 'in'}`);
    row.dataset.msgId = message.id;
    if (state.selectedMsgs.has(message.id)) row.dataset.selected = '1';
    const tick = el('button', 'tick');
    tick.type = 'button';
    tick.setAttribute('aria-pressed', state.selectedMsgs.has(message.id) ? 'true' : 'false');
    tick.setAttribute('aria-label', 'Selecionar mensagem');
    const bubble = el('div', 'bubble');
    if (message.authorLabel && !message.fromMe) bubble.append(el('div', 'author', message.authorLabel));
    if (several && message.accountLabel) bubble.append(el('div', 'account-pill', message.accountLabel));
    if (message.quoted) bubble.append(el('div', 'author', message.quoted));
    appendMedia(bubble, message);
    if (message.body) bubble.append(el('p', 'text', message.body));
    if (message.location) {
      bubble.append(el('p', 'text', `${message.location.lat}, ${message.location.lng}`));
    }
    bubble.append(el('span', 'time', timeLabel(message.timestamp)));
    row.append(tick, bubble);
    box.append(row);
  }
  if (stick) box.scrollTop = box.scrollHeight;
  updateActions();
}

function appendMedia(bubble, message) {
  if (!message.hasMedia) return;
  const query = new URLSearchParams({ messageId: message.id });
  if (message.accountId) query.set('accountId', message.accountId);
  const url = `/api/media?${query}`;
  if (message.type === 'image' || message.type === 'sticker') {
    const img = document.createElement('img');
    img.alt = message.filename || message.type;
    img.loading = 'lazy';
    img.src = url;
    img.addEventListener('error', () => {
      img.replaceWith(el('p', 'missing', 'Mídia não disponível'));
    });
    bubble.append(img);
    return;
  }
  if (message.type === 'video' || message.type === 'gif') {
    const video = document.createElement('video');
    video.controls = true;
    video.src = url;
    bubble.append(video);
    return;
  }
  if (message.type === 'audio' || message.type === 'ptt') {
    const audio = document.createElement('audio');
    audio.controls = true;
    audio.src = url;
    bubble.append(audio);
    return;
  }
  const link = document.createElement('a');
  link.className = 'file-link';
  link.href = url;
  link.download = message.filename || 'arquivo';
  link.textContent = message.filename || 'Arquivo';
  bubble.append(link);
}

function renderComposerAccounts() {
  const select = $('send-account');
  const links = state.openChat ? accountLinks(state.openChat) : [];
  const usable = links.filter((link) => link.accountId);
  select.hidden = usable.length < 2;
  select.replaceChildren();
  for (const link of usable) {
    const option = el('option', '', link.label || link.accountId);
    option.value = link.accountId;
    select.append(option);
  }
  if (state.openChat && state.openChat.accountId) select.value = state.openChat.accountId;
}

function showExports(list, backup) {
  const box = $('export-result');
  box.replaceChildren();
  for (const item of list) {
    const row = el('div', 'export-row');
    const label = backup
      ? `${item.name}: ${item.messages || 0} mensagens, ${item.files} anexos. ${item.html}`
      : `${item.name}: ${item.files} anexos, ${item.missing} indisponíveis. ${item.html}`;
    row.append(el('span', '', label));
    const open = el('button', '', 'Abrir pasta');
    open.type = 'button';
    open.addEventListener('click', () => {
      const body = backup ? { backupId: backup.id } : { chatId: item.chatId };
      api('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }).catch((error) => toast(error.message));
    });
    row.append(open);
    box.append(row);
  }
}

let chatLoadToken = 0;
async function loadChats() {
  const token = ++chatLoadToken;
  let data;
  try {
    data = await api('/api/chats');
  } catch (error) {
    if (token !== chatLoadToken) return;
    state.chatError = error.message;
    state.loaded = false;
    renderChats();
    throw error;
  }
  if (token !== chatLoadToken) return;
  state.chatError = '';
  state.chats = data.chats;
  state.loaded = true;
  const alive = new Set(state.chats.map((chat) => chat.id));
  for (const id of [...state.selectedChats]) {
    if (!alive.has(id)) state.selectedChats.delete(id);
  }
  renderChats();
}

async function openChat(chatId, limit) {
  state.openChatId = chatId;
  state.limit = limit || state.limit || 40;
  const known = state.chats.find((chat) => chat.id === chatId);
  const threadRef = (known && (known.threadId || known.id)) || chatId;
  const data = await api(`/api/thread?id=${encodeURIComponent(threadRef)}&limit=${state.limit}`);
  state.openChat = data.thread;
  state.openChatId = data.thread.id || chatId;
  state.openThreadId = data.thread.threadId || threadRef;
  state.messages = data.messages;
  const alive = new Set(messageIds());
  for (const id of [...state.selectedMsgs]) {
    if (!alive.has(id)) state.selectedMsgs.delete(id);
  }
  renderChats();
  renderThread();
}

function accountSummary(status) {
  const accounts = status.accounts || [];
  if (!accounts.length) return '';
  const ready = accounts.filter((item) => item.status === 'ready').length;
  const qr = accounts.filter((item) => item.status === 'qr').length;
  const parts = [`${ready} número${ready === 1 ? '' : 's'}`];
  if (qr) parts.push(`${qr} no QR`);
  return parts.join(' · ');
}

function applyStatus(status) {
  state.status = status;
  state.accounts = status.accounts || [];
  $('demo-banner').hidden = !status.demo;
  const me = status.me ? `${status.me.name || ''} ${status.me.number || ''}`.trim() : '';
  const labels = {
    idle: 'Desconectado',
    starting: 'Abrindo WhatsApp Web…',
    qr: 'Escaneie o QR com o celular',
    loading: status.percent != null ? `Carregando conversas ${status.percent}%` : 'Carregando conversas…',
    ready: me ? `Conectado: ${me}` : 'Conectado',
    error: status.error || 'Falha na conexão',
  };
  const summary = accountSummary(status);
  $('status-line').textContent = summary && status.status === 'ready' ? summary : (labels[status.status] || status.status);
  if (status.cache) {
    $('cache-line').textContent = `${status.cache.messages} msgs · ${status.cache.files} arquivos`;
  }
  if (status.error && status.status !== 'error') {
    $('status-line').textContent += ` — ${status.error}`;
  }
  if (status.status === 'error') $('connect-text').textContent = status.error || CONNECT_HELP;
  else $('connect-text').textContent = CONNECT_HELP;
  const accounts = status.accounts || [];
  const anyReady = accounts.some((item) => item.status === 'ready') || (!accounts.length && status.status === 'ready');
  const busy = accounts.length
    ? accounts.some((item) => item.status === 'starting' || item.status === 'qr' || item.status === 'loading')
    : (status.status === 'starting' || status.status === 'qr' || status.status === 'loading');
  $('connect').hidden = anyReady || busy || status.status === 'ready';
  $('logout').hidden = !anyReady;
  $('logout').textContent = accounts.length > 1 ? 'Desconectar todos' : 'Desconectar';
  $('workspace').hidden = !anyReady && status.status !== 'ready';
  $('connect-panel').hidden = anyReady || status.status === 'ready';
  $('qr').hidden = status.status !== 'qr';
  $('loading-text').hidden = status.status !== 'starting' && status.status !== 'loading';
  $('loading-text').textContent = labels[status.status] || '';
  $('connect-title').textContent = status.status === 'error' ? 'Falha ao vincular' : 'Vincular WhatsApp Web';
  if (status.error && status.status === 'error') $('connect-text').textContent = status.error;
  const stamp = `${status.demo ? 'demo' : 'real'}:${(status.me && status.me.number) || ''}:${accounts.map((item) => item.id + item.status).join(',')}`;
  if (anyReady && state.accountStamp !== stamp) {
    state.accountStamp = stamp;
    state.loaded = false;
    state.chatError = '';
  }
  if (anyReady && !state.loaded && !state.loadingChats) {
    state.loadingChats = true;
    renderChats();
    loadChats()
      .catch((error) => toast(error.message))
      .finally(() => {
        state.loadingChats = false;
        renderChats();
      });
  }
  if (!$('accounts-panel').hidden) renderAccounts();
  fillFinderAccounts();
}

function setQr(url) {
  $('qr').src = url;
  $('qr').hidden = false;
}

async function runExport(rows) {
  if (state.busy || !rows.length) return;
  state.busy = true;
  $('progress').hidden = false;
  $('progress').textContent = 'Exportando anexos e HTML…';
  updateActions();
  try {
    const payload = selectionTargets(rows);
    const data = await api('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatIds: payload.chatIds, accountIds: payload.accountIds }),
    });
    showExports(data.exports);
    $('progress').textContent = 'Exportação concluída.';
  } catch (error) {
    $('progress').hidden = true;
    toast(error.message);
  } finally {
    state.busy = false;
    updateActions();
  }
}

async function runBackup(rows) {
  if (state.busy || !rows.length) return;
  state.busy = true;
  $('progress').hidden = false;
  $('progress').textContent = 'Gerando backup…';
  updateActions();
  try {
    const payload = selectionTargets(rows);
    const data = await api('/api/backup', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatIds: payload.threadIds }),
    });
    showExports(data.threads || [], data);
    $('progress').textContent = 'Backup concluído.';
  } catch (error) {
    $('progress').hidden = true;
    toast(error.message);
  } finally {
    state.busy = false;
    updateActions();
  }
}

function selectedRows() {
  return state.chats.filter((chat) => state.selectedChats.has(chat.id));
}

function openModal() {
  if (!state.selectedMsgs.size) return;
  $('delete-everyone').checked = false;
  $('modal').hidden = false;
}

function closeModal() {
  $('modal').hidden = true;
}

function showOverlay(id, open) {
  $(id).hidden = !open;
}

async function renderAccounts() {
  const box = $('account-list');
  box.replaceChildren(el('p', 'muted', 'Carregando números…'));
  let data;
  try {
    data = await api('/api/accounts');
  } catch (error) {
    box.replaceChildren(el('p', 'form-error', error.message));
    return;
  }
  state.accounts = data.accounts || [];
  box.replaceChildren();
  if (!state.accounts.length) box.append(el('p', 'muted', 'Nenhum número ainda.'));
  for (const account of state.accounts) {
    const card = el('div', 'account-card');
    const info = el('div');
    const who = account.me ? `${account.me.name || ''} ${account.me.number || ''}`.trim() : account.status;
    info.append(el('strong', '', account.label), el('div', 'muted', who));
    if (account.error) info.append(el('div', 'form-error', account.error));
    const actions = el('div', 'account-actions');
    if (account.status === 'qr') {
      const img = document.createElement('img');
      img.alt = `QR de ${account.label}`;
      img.src = `/api/accounts/${encodeURIComponent(account.id)}/qr?t=${Date.now()}`;
      api(`/api/accounts/${encodeURIComponent(account.id)}/qr`).then((payload) => {
        img.src = payload.qr;
      }).catch(() => {});
      info.append(img);
    }
    if (account.status === 'idle' || account.status === 'error') {
      const connect = el('button', '', 'Conectar');
      connect.type = 'button';
      connect.addEventListener('click', () => {
        api(`/api/accounts/${account.id}/connect`, { method: 'POST' }).catch((error) => toast(error.message));
      });
      actions.append(connect);
    }
    if (account.status === 'ready') {
      const off = el('button', '', 'Desconectar');
      off.type = 'button';
      off.addEventListener('click', () => {
        api(`/api/accounts/${account.id}/logout`, { method: 'POST' }).catch((error) => toast(error.message));
      });
      actions.append(off);
    }
    const rename = el('button', '', 'Renomear');
    rename.type = 'button';
    rename.addEventListener('click', () => {
      const label = window.prompt('Nome do número', account.label);
      if (!label) return;
      api(`/api/accounts/${account.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label }),
      }).then(renderAccounts).catch((error) => toast(error.message));
    });
    const remove = el('button', '', 'Remover');
    remove.type = 'button';
    remove.addEventListener('click', () => {
      if (!window.confirm(`Remover ${account.label} deste computador? A sessão local será apagada.`)) return;
      api(`/api/accounts/${account.id}`, { method: 'DELETE' })
        .then(renderAccounts)
        .catch((error) => toast(error.message));
    });
    actions.append(rename, remove);
    card.append(info, actions);
    box.append(card);
  }
}

function fillFinderAccounts() {
  const select = $('finder-account');
  const current = select.value;
  select.replaceChildren(el('option', '', 'Todos os números'));
  select.firstChild.value = '';
  for (const account of state.accounts) {
    const option = el('option', '', account.label);
    option.value = account.id;
    select.append(option);
  }
  if ([...select.options].some((option) => option.value === current)) select.value = current;
}

async function runFinder(event) {
  event.preventDefault();
  const query = $('finder-query').value.trim();
  const kind = $('finder-kind').value;
  const box = $('finder-results');
  box.replaceChildren(el('p', 'muted', 'Buscando…'));
  try {
    const params = new URLSearchParams({ q: query, kind, accountId: $('finder-account').value });
    const data = await api(`/api/search?${params}`);
    box.replaceChildren();
    if (!data.results.length) {
      box.append(el('p', 'muted', 'Nada no cache para essa busca.'));
      return;
    }
    for (const hit of data.results) {
      const button = el('button', 'hit');
      button.type = 'button';
      const title = hit.chatName || hit.name || 'Conversa';
      const where = [hit.accountLabel, hit.numberLabel || hit.filename || ''].filter(Boolean).join(' · ');
      button.append(el('div', '', title), el('div', 'snippet', hit.snippet || hit.preview || hit.filename || ''), el('div', 'muted', where));
      button.addEventListener('click', () => {
        const chatId = hit.chatId || (hit.threadId ? hit.id : '');
        showOverlay('finder-panel', false);
        if (!chatId) return;
        const known = state.chats.find((chat) => chat.id === chatId || chat.threadId === (hit.threadId || hit.threadKey));
        openChat(known ? known.id : chatId).catch((error) => toast(error.message));
      });
      box.append(button);
    }
  } catch (error) {
    box.replaceChildren(el('p', 'form-error', error.message));
  }
}

async function renderUsers() {
  const box = $('user-list');
  box.replaceChildren(el('p', 'muted', 'Carregando…'));
  try {
    const data = await api('/api/users');
    box.replaceChildren();
    for (const user of data.users) {
      const row = el('div', 'user-row');
      row.append(el('div', '', `${user.username} · ${user.role}${user.disabled ? ' · desativado' : ''}`));
      const actions = el('div');
      if (user.id !== state.session.user.id) {
        const toggle = el('button', '', user.disabled ? 'Ativar' : 'Desativar');
        toggle.type = 'button';
        toggle.addEventListener('click', () => {
          api(`/api/users/${user.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ disabled: !user.disabled }),
          }).then(renderUsers).catch((error) => toast(error.message));
        });
        const role = el('button', '', user.role === 'admin' ? 'Tornar usuário' : 'Tornar admin');
        role.type = 'button';
        role.addEventListener('click', () => {
          api(`/api/users/${user.id}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ role: user.role === 'admin' ? 'user' : 'admin' }),
          }).then(renderUsers).catch((error) => toast(error.message));
        });
        const remove = el('button', '', 'Excluir');
        remove.type = 'button';
        remove.addEventListener('click', () => {
          api(`/api/users/${user.id}`, { method: 'DELETE' })
            .then(renderUsers)
            .catch((error) => toast(error.message));
        });
        actions.append(toggle, role, remove);
      }
      row.append(actions);
      box.append(row);
    }
  } catch (error) {
    box.replaceChildren(el('p', 'form-error', error.message));
  }
}

function syncKind() {
  const kind = $('send-kind').value;
  const fileKinds = new Set(['image', 'video', 'audio', 'ptt', 'document', 'sticker']);
  $('send-file').hidden = !fileKinds.has(kind);
  $('send-text').hidden = kind === 'location' || kind === 'contact';
  $('send-extra').hidden = kind !== 'location' && kind !== 'contact';
  $('send-lat').hidden = kind !== 'location';
  $('send-lng').hidden = kind !== 'location';
  $('send-phone').hidden = kind !== 'contact';
  $('send-description').placeholder = kind === 'contact' ? 'Nome do contato' : 'Descrição do local';
}

$('chats').addEventListener('click', (event) => {
  const row = event.target.closest('[data-chat-id]');
  if (!row) return;
  const id = row.dataset.chatId;
  const onTick = Boolean(event.target.closest('.tick'));
  if (event.shiftKey || onTick) {
    if (event.shiftKey) event.preventDefault();
    const result = Selection.applyClick(visibleChatIds(), state.selectedChats, state.chatAnchor, id, {
      shift: event.shiftKey,
      toggle: onTick && !event.shiftKey,
    });
    state.selectedChats = result.selected;
    state.chatAnchor = result.anchorId;
    renderChatSelection();
    if (!onTick || event.shiftKey) {
      openChat(id).catch((error) => toast(error.message));
    }
    return;
  }
  openChat(id).catch((error) => toast(error.message));
});

$('messages').addEventListener('click', (event) => {
  const row = event.target.closest('[data-msg-id]');
  if (!row) return;
  if (event.target.closest('a, audio, video')) return;
  const id = row.dataset.msgId;
  const onTick = Boolean(event.target.closest('.tick'));
  if (event.shiftKey) event.preventDefault();
  const result = Selection.applyClick(messageIds(), state.selectedMsgs, state.msgAnchor, id, {
    shift: event.shiftKey,
    toggle: event.ctrlKey || event.metaKey || (onTick && !event.shiftKey),
  });
  state.selectedMsgs = result.selected;
  state.msgAnchor = result.anchorId;
  renderMessagesOnly();
});

function renderMessagesOnly() {
  const selected = state.selectedMsgs;
  for (const row of $('messages').querySelectorAll('[data-msg-id]')) {
    const on = selected.has(row.dataset.msgId);
    if (on) row.dataset.selected = '1';
    else delete row.dataset.selected;
    const tick = row.querySelector('.tick');
    if (tick) tick.setAttribute('aria-pressed', on ? 'true' : 'false');
  }
  updateActions();
}

$('search').addEventListener('input', (event) => {
  state.query = event.target.value;
  renderChats();
});

$('refresh-chats').addEventListener('click', () => {
  loadChats().catch((error) => toast(error.message));
});

$('select-visible-chats').addEventListener('click', () => {
  const ids = visibleChatIds();
  state.selectedChats = new Set(ids);
  state.chatAnchor = ids[0] || null;
  renderChats();
});

$('clear-chats').addEventListener('click', () => {
  state.selectedChats.clear();
  state.chatAnchor = null;
  renderChats();
});

$('export-selected').addEventListener('click', () => {
  runExport(selectedRows());
});

$('backup-selected').addEventListener('click', () => {
  runBackup(selectedRows());
});

$('export-one').addEventListener('click', () => {
  const row = state.chats.find((chat) => chat.id === state.openChatId) || state.openChat;
  if (row) runExport([row]);
});

$('backup-one').addEventListener('click', () => {
  const row = state.chats.find((chat) => chat.id === state.openChatId) || state.openChat;
  if (row) runBackup([row]);
});

$('load-more').addEventListener('click', () => {
  if (!state.openChatId) return;
  openChat(state.openChatId, state.limit + 40).catch((error) => toast(error.message));
});

$('select-loaded').addEventListener('click', () => {
  state.selectedMsgs = new Set(messageIds());
  state.msgAnchor = state.messages[0]?.id || null;
  renderMessagesOnly();
});

$('clear-msgs').addEventListener('click', () => {
  state.selectedMsgs.clear();
  state.msgAnchor = null;
  renderMessagesOnly();
});

$('delete-messages').addEventListener('click', openModal);
$('cancel-delete').addEventListener('click', closeModal);
$('modal').addEventListener('click', (event) => {
  if (event.target === $('modal')) closeModal();
});

$('confirm-delete').addEventListener('click', async () => {
  const ids = [...state.selectedMsgs];
  const everyone = $('delete-everyone').checked;
  closeModal();
  if (!ids.length) return;
  state.busy = true;
  updateActions();
  try {
    const result = await api('/api/messages/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageIds: ids, everyone }),
    });
    state.selectedMsgs.clear();
    state.msgAnchor = null;
    if (state.openChatId) await openChat(state.openChatId, state.limit);
    const removed = result.deleted?.length || 0;
    if (result.failed?.length) {
      toast(`${removed} excluídas. ${result.failed.length} falharam: ${result.failed[0].error}`);
    } else if (removed) {
      toast(removed === 1 ? 'Mensagem excluída' : `${removed} mensagens excluídas`);
    }
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
    updateActions();
  }
});

$('connect').addEventListener('click', () => {
  $('status-line').textContent = 'Abrindo WhatsApp Web…';
  $('connect').hidden = true;
  api('/api/connect', { method: 'POST' }).catch((error) => {
    toast(error.message);
    $('connect').hidden = false;
  });
});

$('logout').addEventListener('click', () => {
  state.loaded = false;
  state.chats = [];
  state.openChat = null;
  state.openChatId = null;
  state.selectedChats.clear();
  state.selectedMsgs.clear();
  api('/api/logout', { method: 'POST' }).catch((error) => toast(error.message));
});

$('send-kind').addEventListener('change', syncKind);

$('composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!state.openChatId || state.busy) return;
  const kind = $('send-kind').value;
  const links = state.openChat ? accountLinks(state.openChat) : [];
  const chosen = $('send-account').value;
  const link = links.find((item) => item.accountId === chosen) || links[0] || { chatId: state.openChatId, accountId: '' };
  const file = $('send-file').files && $('send-file').files[0];
  const body = new FormData();
  body.set('chatId', link.chatId || state.openChatId);
  body.set('accountId', link.accountId || '');
  body.set('kind', kind);
  body.set('text', $('send-text').value);
  body.set('lat', $('send-lat').value);
  body.set('lng', $('send-lng').value);
  body.set('description', kind === 'contact' ? '' : $('send-description').value);
  body.set('contactName', $('send-description').value);
  body.set('contactPhone', $('send-phone').value);
  if (file) body.set('file', file);
  state.busy = true;
  updateActions();
  try {
    await api('/api/send', { method: 'POST', body });
    $('send-text').value = '';
    $('send-file').value = '';
    await openChat(state.openChatId, state.limit);
  } catch (error) {
    toast(error.message);
  } finally {
    state.busy = false;
    updateActions();
  }
});

$('open-accounts').addEventListener('click', () => {
  showOverlay('accounts-panel', true);
  renderAccounts();
});
$('close-accounts').addEventListener('click', () => showOverlay('accounts-panel', false));
$('account-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const label = $('account-label').value.trim();
  api('/api/accounts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ label }),
  }).then(() => {
    $('account-label').value = '';
    return renderAccounts();
  }).catch((error) => toast(error.message));
});

$('open-finder').addEventListener('click', () => {
  fillFinderAccounts();
  showOverlay('finder-panel', true);
  $('finder-query').focus();
});
$('close-finder').addEventListener('click', () => showOverlay('finder-panel', false));
$('finder-form').addEventListener('submit', runFinder);

$('open-users').addEventListener('click', () => {
  showOverlay('users-panel', true);
  renderUsers();
});
$('close-users').addEventListener('click', () => showOverlay('users-panel', false));
$('user-form').addEventListener('submit', (event) => {
  event.preventDefault();
  api('/api/users', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: $('user-name').value,
      password: $('user-pass').value,
      role: $('user-role').value,
    }),
  }).then(() => {
    $('user-name').value = '';
    $('user-pass').value = '';
    return renderUsers();
  }).catch((error) => toast(error.message));
});

$('open-password').addEventListener('click', () => showOverlay('password-panel', true));
$('close-password').addEventListener('click', () => showOverlay('password-panel', false));
$('password-form').addEventListener('submit', (event) => {
  event.preventDefault();
  api('/api/auth/password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ current: $('password-current').value, next: $('password-next').value }),
  }).then(() => {
    $('password-current').value = '';
    $('password-next').value = '';
    showOverlay('password-panel', false);
    toast('Senha atualizada');
  }).catch((error) => toast(error.message));
});

$('setup-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('setup-error').textContent = '';
  api('/api/auth/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: $('setup-user').value, password: $('setup-pass').value }),
  }).then((data) => enterApp({ demo: false, user: data.user, needsSetup: false }))
    .catch((error) => { $('setup-error').textContent = error.message; });
});

$('login-form').addEventListener('submit', (event) => {
  event.preventDefault();
  $('login-error').textContent = '';
  api('/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: $('login-user').value, password: $('login-pass').value }),
  }).then((data) => enterApp({ demo: false, user: data.user, needsSetup: false }))
    .catch((error) => { $('login-error').textContent = error.message; });
});

$('sign-out').addEventListener('click', () => {
  api('/api/auth/logout', { method: 'POST' }).finally(() => window.location.reload());
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    closeModal();
    showOverlay('accounts-panel', false);
    showOverlay('finder-panel', false);
    showOverlay('users-panel', false);
    showOverlay('password-panel', false);
  }
  const typing = document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA' || document.activeElement.tagName === 'SELECT');
  if (event.key === 'Delete' && !typing && state.selectedMsgs.size) openModal();
});

function onLive(payload) {
  const chat = payload && payload.chat;
  const message = payload && payload.message;
  if (!chat || !message) return;
  const row = state.chats.find((item) => item.threadId === chat.threadKey || item.id === chat.id);
  if (row) {
    row.preview = message.body || message.type || row.preview;
    row.timestamp = message.timestamp || row.timestamp;
    state.chats.sort((a, b) => b.timestamp - a.timestamp);
    renderChats();
  } else if (!state.loadingChats) {
    loadChats().catch(() => {});
  }
  if (state.openThreadId && chat.threadKey === state.openThreadId && !state.messages.some((item) => item.id === message.id)) {
    state.messages.push(message);
    renderThread();
  }
}

let socket;
function bootSocket() {
  if (typeof io !== 'function' || socket) return;
  socket = io();
  socket.on('status', applyStatus);
  socket.on('qr', setQr);
  socket.on('account', (message) => {
    if (message.event === 'qr' && typeof message.payload === 'string') {
      if ($('workspace').hidden) setQr(message.payload);
      else if (!$('accounts-panel').hidden) renderAccounts();
      else showOverlay('accounts-panel', true);
    }
    if (message.event === 'status' && !$('accounts-panel').hidden) renderAccounts();
  });
  socket.on('live', onLive);
  socket.on('progress', (progress) => {
    if (!progress.file) return;
    $('progress').hidden = false;
    $('progress').textContent = `${progress.name || 'Conversa'}: ${progress.file}`;
  });
}

function showSessionChrome(session) {
  const user = session && session.user;
  const real = Boolean(user);
  $('who').textContent = user ? user.username : '';
  $('sign-out').hidden = !real;
  $('open-password').hidden = !real;
  $('open-users').hidden = !user || user.role !== 'admin';
  $('open-accounts').hidden = Boolean(session && session.demo);
  $('open-finder').hidden = false;
}

async function enterApp(session) {
  state.session = session;
  $('gate').hidden = true;
  $('setup-form').hidden = true;
  $('login-form').hidden = true;
  showSessionChrome(session);
  try {
    applyStatus(await api('/api/status'));
    const cache = await api('/api/cache');
    $('cache-line').textContent = `${cache.messages} msgs · ${cache.files} arquivos`;
    const qr = await fetch('/api/qr');
    if (qr.ok) {
      const data = await qr.json();
      if (data.qr) setQr(data.qr);
    }
  } catch (error) {
    toast(error.message);
  }
  bootSocket();
  syncKind();
}

function showGate(session) {
  $('gate').hidden = false;
  $('connect-panel').hidden = true;
  $('workspace').hidden = true;
  $('setup-form').hidden = !session.needsSetup;
  $('login-form').hidden = session.needsSetup;
  $('open-finder').hidden = true;
}

async function boot() {
  try {
    const session = await api('/api/auth/session');
    if (!session.demo && (session.needsSetup || !session.user)) {
      showGate(session);
      return;
    }
    await enterApp(session);
  } catch (error) {
    toast(error.message);
  }
}

boot();
