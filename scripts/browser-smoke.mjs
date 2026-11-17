// Optional browser verification through Chromium's local DevTools protocol.
// Start Edge/Chrome with --headless=new --remote-debugging-port=9223 first.
import { mkdir, writeFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { Repository } from '../server/database.mjs';
import { AIService } from '../server/ai/providers.mjs';
import { SpeechService } from '../server/ai/speech.mjs';
import { AgentOrchestrator } from '../server/agents/orchestrator.mjs';
import { createApplication } from '../server/app.mjs';
import { TestProvider } from '../tests/fixtures.mjs';

const debugging = process.env.BROWSER_DEBUG_URL || 'http://127.0.0.1:9223';
const appUrl = process.env.BROWSER_APP_URL || 'http://localhost:3000';
const tabs = await (await fetch(`${debugging}/json/list`)).json();
const tab = tabs.find(item => item.type === 'page');
if (!tab) throw new Error('No browser page is available.');
const socket = new WebSocket(tab.webSocketDebuggerUrl);
await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
let sequence = 0; const pending = new Map(); const errors = [];
socket.addEventListener('message', event => {
  const message = JSON.parse(event.data);
  if (message.id) {
    const waiter = pending.get(message.id); if (!waiter) return;
    pending.delete(message.id); clearTimeout(waiter.timer);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  } else if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.text);
  else if (message.method === 'Log.entryAdded' && message.params.entry.level === 'error') errors.push(message.params.entry.text);
});
function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`DevTools timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result.value;
}
async function waitFor(expression) {
  for (let i = 0; i < 60; i++) { if (await evaluate(expression)) return; await new Promise(resolve => setTimeout(resolve, 100)); }
  throw new Error(`Browser condition timed out: ${expression}`);
}
try {
  await call('Page.enable'); await call('Runtime.enable'); await call('Log.enable');
  await call('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await call('Page.navigate', { url: appUrl });
  await waitFor("document.querySelector('.hero') && document.querySelector('.preview-notice')");
  await mkdir('artifacts', { recursive: true });
  await writeFile('artifacts/desktop.png', Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  for (const route of ['conversation','practice','translate','speaking','grammar','vocabulary','writing','listening','dictionary','documents','progress','profile','tools','path','agents']) {
    await evaluate(`location.hash = '${route}'`);
    await waitFor(`document.querySelector('.content')?.dataset.page === '${route}'`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true, `${route} overflowed at desktop width`);
  }
  await evaluate("location.hash = 'tools'");await waitFor("document.querySelectorAll('.tool-card').length === 17");
  await evaluate("document.querySelector('[data-action=toggle-theme]').click()");
  assert.equal(await evaluate("document.documentElement.dataset.theme"),'dark');
  await writeFile('artifacts/tools-dark.png',Buffer.from((await call('Page.captureScreenshot',{format:'png'})).data,'base64'));
  await evaluate("document.querySelector('[data-action=toggle-theme]').click()");
  await evaluate("document.querySelector('[data-action=auth]').click()");
  await waitFor("document.querySelector('#modal').open && document.querySelector('#auth-form')");
  await evaluate("document.querySelector('[data-action=auth-mode]').click()");
  assert.equal(await evaluate("document.querySelector('#auth-form').dataset.mode"), 'login');
  await evaluate("document.querySelector('[data-action=close-modal]').click()");
  await evaluate("location.hash = 'dashboard'"); await waitFor("Boolean(document.querySelector('.hero'))");
  await call('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
  await new Promise(resolve => setTimeout(resolve, 300));
  await writeFile('artifacts/mobile.png', Buffer.from((await call('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  for (const route of ['translate','speaking','writing','documents','dictionary','tools','profile']) {
    await evaluate(`location.hash = '${route}'`);await waitFor(`document.querySelector('.content')?.dataset.page === '${route}'`);
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,`${route} overflowed at mobile width`);
  }
  await evaluate("location.hash = 'dashboard'");await waitFor("Boolean(document.querySelector('.hero'))");
  await evaluate("document.querySelector('[data-action=menu]').click()");
  assert.equal(await evaluate("document.querySelector('.sidebar').classList.contains('open')"), true);
  await evaluate("document.querySelector('[data-route=vocabulary]').click()");
  await waitFor("Boolean(document.querySelector('.flashcard'))");
  await evaluate("document.querySelector('[data-action=reveal]').click()");
  assert.equal(await evaluate("document.querySelector('.translation').textContent"), 'to make the most of');
  await evaluate("document.querySelector('[data-action=review]').click()");
  assert.equal(await evaluate("document.querySelector('#modal').open"), true);
  await evaluate("document.querySelector('[data-action=close-modal]').click()");
  const repository = new Repository(':memory:');
  const ai = new AIService({ provider: 'disabled' });
  const speech = new SpeechService({ provider: 'disabled' });
  const orchestrator = new AgentOrchestrator({ repository, ai, speech });
  const port = Number(process.env.BROWSER_TEST_PORT || 3001);
  const server = createApplication({ config: { host: '127.0.0.1', port, origin: `http://localhost:${port}`, secureCookie: false }, repository, ai, speech, orchestrator });
  server.listen(port, '127.0.0.1'); await once(server, 'listening');
  try {
    await call('Page.navigate', { url: `http://localhost:${port}` });
    await waitFor("Boolean(document.querySelector('.preview-notice'))");
    await evaluate("document.querySelector('.topbar [data-action=auth]').click()");
    await evaluate(`document.querySelector('#name').value = 'Browser Learner'; document.querySelector('#email').value = 'browser@example.com'; document.querySelector('#password').value = 'browser-test-password'; document.querySelector('#auth-form').requestSubmit()`);
    await waitFor("!document.querySelector('.preview-notice') && !document.querySelector('#modal').open");
    assert.equal(await evaluate("fetch('/api/dashboard').then(response => response.json()).then(data => data.stats.totalWords)"), 0);
    await evaluate("document.querySelector('.topbar [data-action=settings]').click()");
    await evaluate("document.querySelector('#language').value = 'French'; document.querySelector('#language').dispatchEvent(new Event('change',{bubbles:true})); document.querySelector('#level').value = 'C1'; document.querySelector('#settings-form').requestSubmit()");
    await waitFor("!document.querySelector('#modal').open && document.querySelector('.language-switch').textContent.includes('French')");
    await evaluate("document.querySelector('.topbar [data-action=language-picker]').click(); document.querySelector('[data-action=add-language]').click(); document.querySelector('#add-language-form').requestSubmit()");
    await waitFor("!document.querySelector('#modal').open && document.querySelector('.language-switch').textContent.includes('Kannada')");
    assert.equal(await evaluate("fetch('/api/profiles').then(r=>r.json()).then(data=>data.profiles.length)"),3);
    await evaluate("document.querySelector('[data-action=search]').click(); document.querySelector('#universal-search').value='Kannada'; document.querySelector('#universal-search').dispatchEvent(new Event('input',{bubbles:true}))");
    await waitFor("document.querySelector('#search-results').textContent.includes('Kannada learning profile')");
    await evaluate("document.querySelector('[data-action=close-modal]').click(); document.querySelector('.topbar [data-action=language-picker]').click(); document.querySelector('[data-language=French]').click()");
    await waitFor("!document.querySelector('#modal').open && document.querySelector('.language-switch').textContent.includes('French')");
    await evaluate("document.querySelector('[data-route=practice]').click()");
    await evaluate("document.querySelector('#generate-form').requestSubmit()");
    await waitFor("document.querySelector('#modal').open && document.querySelector('.config-code')");
    assert.equal(await evaluate("fetch('/api/runs').then(response => response.json()).then(data => data.runs.length)"), 0);
    // Named fixture provider is enabled only in this isolated, in-memory test server.
    ai.settings = {provider:'openai-compatible',model:'browser-test-model',apiKey:'test-only',timeoutMs:3000};
    ai.provider = new TestProvider();
    await evaluate("document.querySelector('[data-action=close-modal]').click()");
    await call('Page.navigate',{url:`http://localhost:${port}/?verification=agent#translate`});
    await waitFor("document.querySelector('#language-tool-form') && document.querySelector('.tool-status')?.textContent.includes('Service settings configured')");
    await evaluate("document.querySelector('#tool-text').value='Private learning text.'; document.querySelector('#language-tool-form').requestSubmit()");
    await waitFor("document.querySelector('.tool-output .translated-text')?.textContent.includes('Hello') && !document.querySelector('.busy-banner')");
    assert.equal(await evaluate("fetch('/api/dashboard').then(r=>r.json()).then(data=>data.toolHistory.length)"),1);
    await evaluate("document.querySelector('[data-action=open-tool-practice]').click()");
    await waitFor("document.querySelector('.content')?.dataset.page === 'practice' && document.querySelector('.question-options')");
    await evaluate("document.querySelectorAll('.question-options').forEach(group=>group.querySelector('input').checked=true); document.querySelector('#activity-form').requestSubmit()");
    await waitFor("document.querySelector('.score')?.textContent.includes('100') && !document.querySelector('.busy-banner')");
    await evaluate("document.querySelector('[data-action=practice-tab][data-kind=writing]').click(); document.querySelector('#generate-form').requestSubmit()");
    await waitFor("document.querySelector('#activity-form .writing-input') && !document.querySelector('.busy-banner')");
    await evaluate("document.querySelector('#activity-form .writing-input').value='A practice essay to improve.'; document.querySelector('#activity-form').requestSubmit()");
    await waitFor("document.querySelector('.specialist-feedback')?.textContent.includes('A clear, natural test sentence.') && !document.querySelector('.busy-banner')");
    await evaluate("document.querySelector('.specialist-feedback').open=true");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'),true,'writing feedback overflowed at mobile width');
    await evaluate("document.querySelector('[data-action=practice-tab][data-kind=lesson]').click(); document.querySelector('#activity-focus').value='Idioms and cultural expressions'; document.querySelector('#generate-form').requestSubmit()");
    await waitFor("document.querySelector('.specialist-feedback')?.textContent.includes('A polite everyday greeting.') && !document.querySelector('.busy-banner')");
    await evaluate("document.querySelector('[data-route=writing]').click()");
    await evaluate("document.querySelector('#tool-text').value='An essay to improve.'; document.querySelector('#language-tool-form').requestSubmit()");
    await waitFor("document.querySelector('.translated-text')?.textContent.includes('A clear, natural test sentence.') && !document.querySelector('.busy-banner')");
    await evaluate("document.querySelector('[data-route=documents]').click()");
    await evaluate("const transfer=new DataTransfer(); transfer.items.add(new File(['Real document bytes.'],'browser.txt',{type:'text/plain'})); document.querySelector('#tool-file').files=transfer.files; document.querySelector('#tool-file').dispatchEvent(new Event('change',{bubbles:true}))");
    await waitFor("document.querySelector('.upload-zone strong')?.textContent.includes('browser.txt')");
    await evaluate("document.querySelector('#language-tool-form').requestSubmit()");
    await waitFor("document.querySelector('.translated-text')?.textContent.includes('Translated document section.') && !document.querySelector('.busy-banner')");
    assert.equal(await evaluate("fetch('/api/dashboard').then(r=>r.json()).then(data=>data.toolHistory[0].result.extractedText)"),'Real document bytes.');
    await evaluate("document.querySelector('.topbar [data-action=settings]').click(); document.querySelector('[data-action=logout]').click()");
    await waitFor("Boolean(document.querySelector('.preview-notice'))");
    await evaluate("document.querySelector('[data-route=translate]').click()");
    assert.equal(await evaluate("Boolean(document.querySelector('.tool-output .translated-text'))"),false,'private tool results must clear on logout');
    await evaluate("document.querySelector('.topbar [data-action=auth]').click(); document.querySelector('[data-action=auth-mode]').click(); document.querySelector('#email').value = 'browser@example.com'; document.querySelector('#password').value = 'browser-test-password'; document.querySelector('#auth-form').requestSubmit()");
    await waitFor("!document.querySelector('.preview-notice') && document.querySelector('.language-switch').textContent.includes('French')");
    assert.equal(await evaluate('document.documentElement.scrollWidth <= innerWidth'), true);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); repository.close(); }
  assert.deepEqual(errors, []);
  console.log('Browser smoke passed: 16 routes, 17 tools, layouts, themes, search, profiles, configuration gating, translation-to-quiz, writing and cultural learning feedback, file upload, and logout privacy. AI outputs use an isolated test provider.');
  console.log('Screenshots: artifacts/desktop.png and artifacts/mobile.png');
} finally { socket.close(); }
