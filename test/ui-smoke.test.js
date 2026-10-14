const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createApp } = require('../server/index');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

async function listen(ctx) {
  await new Promise((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
  return ctx.server.address().port;
}

async function shutdown(ctx) {
  await new Promise((resolve) => ctx.io.close(() => resolve()));
  if (ctx.server.listening) {
    await new Promise((resolve) => ctx.server.close(() => resolve()));
  }
}

test('ui mostra contato, shift seleciona mensagens e exporta', { timeout: 90000 }, async () => {
  assert.equal(fs.existsSync(CHROME), true, 'Chrome não encontrado');
  const puppeteer = require('puppeteer-core');
  const exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wa-ui-'));
  const ctx = createApp({ demo: true, exportRoot });
  let browser;
  try {
    const port = await listen(ctx);
    browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-gpu'],
    });
    const page = await browser.newPage();
    await page.setViewport({ width: 1400, height: 900 });
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('[data-chat-id="c1"]');
    await page.waitForFunction(() => {
      const img = document.querySelector('[data-chat-id="c1"] img');
      return img && img.naturalWidth > 0;
    });
    const listed = await page.$eval('[data-chat-id="c1"]', (row) => ({
      name: row.querySelector('.name').textContent,
      number: row.querySelector('.meta').textContent,
    }));
    assert.equal(listed.name, 'Maria Silva');
    assert.equal(listed.number, '+55 11 98765-4321');

    await page.click('[data-chat-id="c1"]');
    await page.waitForSelector('[data-msg-id="m2"]');
    await page.waitForFunction(() => {
      const title = document.querySelector('#thread-head h2');
      const phone = document.querySelector('#thread-head p');
      const img = document.querySelector('#thread-head img');
      return title && title.textContent === 'Maria Silva'
        && phone && phone.textContent.includes('+55 11 98765-4321')
        && img && img.naturalWidth > 0;
    });

    await page.click('[data-msg-id="m2"]');
    await page.keyboard.down('Shift');
    await page.click('[data-msg-id="m5"]');
    await page.keyboard.up('Shift');
    const selected = await page.$$eval('#messages [data-selected="1"]', (nodes) => nodes.map((node) => node.dataset.msgId));
    assert.deepEqual(selected, ['m2', 'm3', 'm4', 'm5']);

    await page.click('#delete-messages');
    await page.waitForSelector('#modal:not([hidden])');
    await page.click('#confirm-delete');
    await page.waitForFunction(() => !document.querySelector('[data-msg-id="m2"]'));
    assert.ok(await page.$('[data-msg-id="m1"]'));
    assert.ok(await page.$('[data-msg-id="m6"]'));

    await page.click('[data-chat-id="c1"] .tick');
    await page.keyboard.down('Shift');
    await page.click('[data-chat-id="c3"] .tick');
    await page.keyboard.up('Shift');
    const chats = await page.$$eval('#chats [data-selected="1"]', (nodes) => nodes.map((node) => node.dataset.chatId));
    assert.deepEqual(chats, ['c1', 'c2', 'c3']);

    await page.click('#export-selected');
    await page.waitForFunction(() => document.querySelector('#export-result').textContent.includes('conversa.html'));
    const result = await page.$eval('#export-result', (node) => node.textContent);
    assert.match(result, /Maria Silva/);
    assert.match(result, /conversa\.html/);
    assert.equal(fs.existsSync(path.join(exportRoot, 'Maria Silva', '5511987654321', 'imagens')), true);
  } finally {
    if (browser) await browser.close();
    await shutdown(ctx);
    fs.rmSync(exportRoot, { recursive: true, force: true });
  }
});
