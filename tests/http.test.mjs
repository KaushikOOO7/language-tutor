import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createApplication } from '../server/app.mjs';
import { AIService } from '../server/ai/providers.mjs';
import { setup, profile, wav } from './fixtures.mjs';

async function serve(t, disabled = false) {
  const env = setup();
  const ai = disabled ? new AIService({ provider: 'disabled' }) : env.ai;
  if (disabled) env.orchestrator.ai = ai;
  const config = { host: '127.0.0.1', port: 0, origin: 'https://tutor.example', secureCookie: false };
  const server = createApplication({ ...env, config, ai });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); env.repository.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, body, cookie, headers = {}) => {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(cookie ? { Cookie: cookie } : {}), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, headers: response.headers, body: await response.json() };
  };
  const register = async (email = 'new@example.com') => {
    const response = await request('/api/auth/register', { email, name: 'New Learner', password: 'a-real-test-password', ...profile });
    assert.equal(response.status, 200);
    return { cookie: response.headers.get('set-cookie').split(';')[0], response };
  };
  return { ...env, base, request, register };
}

test('registration, login, protected data and logout use hashed passwords and HttpOnly sessions', async t => {
  const env = await serve(t);
  assert.equal((await env.request('/api/dashboard')).status, 401);
  const { cookie, response } = await env.register();
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Lax/);
  assert.equal(response.body.user.password_hash, undefined);
  const savedUser = env.repository.userByEmail('new@example.com');
  assert.notEqual(savedUser.password_hash, 'a-real-test-password');
  const session = env.repository.db.prepare('SELECT token_hash FROM sessions WHERE user_id = ?').get(savedUser.id);
  assert.notEqual(session.token_hash, cookie.split('=')[1]);
  const dashboard = await env.request('/api/dashboard', undefined, cookie);
  assert.equal(dashboard.body.stats.sessions, 0);
  assert.equal(dashboard.body.stats.totalWords, 0);
  assert.equal(dashboard.body.plan, null);
  assert.equal((await env.request('/api/auth/login', { email: 'new@example.com', password: 'wrong-password' })).status, 401);
  assert.equal((await env.request('/api/auth/login', { email: 'new@example.com', password: 'a-real-test-password' })).status, 200);
  assert.equal((await env.request('/api/auth/logout', {}, cookie)).status, 200);
  assert.equal((await env.request('/api/dashboard', undefined, cookie)).status, 401);
});

test('all levels receive all fourteen agents and learning tools; profile changes isolate languages', async t => {
  const env = await serve(t);
  const { cookie } = await env.register();
  const status = await env.request('/api/status');
  assert.equal(status.body.agents.length, 14);
  assert.equal(status.body.tools.length,17);
  assert.ok(status.body.languages.includes('Kannada'));
  assert.equal(status.body.activityKinds.length, 8);
  const conversation = await env.request('/api/workflows/conversation', { message: 'Yo tener café', durationSeconds: 120 }, cookie);
  assert.equal(conversation.status, 200);
  const dashboard = await env.request('/api/dashboard', undefined, cookie);
  assert.equal(dashboard.body.stats.sessions, 1);
  assert.equal(dashboard.body.insights.recommendation.kind, 'quiz');
  assert.equal(dashboard.body.attempts[0].result.tutor.memory, undefined);
  assert.equal(dashboard.body.attempts[0].result.grammar.exercises[0].answerIndex, undefined);
  const change = await env.request('/api/profile', { ...profile, language: 'French', level: 'C2' }, cookie);
  assert.equal(change.status, 200);
  const french = await env.request('/api/dashboard', undefined, cookie);
  assert.equal(french.body.stats.totalWords, 0);
  assert.equal(french.body.stats.sessions, 0);
  assert.equal(french.body.insights, null);
  assert.equal((await env.request('/api/status')).body.agents.length, 14);
});

test('missing AI credentials give an explicit error and never change learning data', async t => {
  const env = await serve(t, true);
  const { cookie } = await env.register();
  const response = await env.request('/api/workflows/conversation', { message: 'Hola' }, cookie);
  assert.equal(response.status, 503); assert.equal(response.body.error.code, 'AI_NOT_CONFIGURED');
  const dashboard = await env.request('/api/dashboard', undefined, cookie);
  assert.equal(dashboard.body.conversation.length, 0);
  assert.equal(dashboard.body.runs.length, 0);
  assert.equal(env.provider.calls.length, 0);
});

test('cross-site writes, invalid input, hidden files and malformed JSON are rejected', async t => {
  const env = await serve(t);
  const { cookie } = await env.register();
  assert.equal((await env.request('/api/profile', profile, cookie, { Origin: 'https://malicious.example' })).status, 403);
  assert.equal((await env.request('/api/workflows/conversation', { message: ' ' }, cookie)).status, 400);
  assert.equal((await env.request('/api/profile', { ...profile, language: '__proto__' }, cookie)).status, 400);
  const secretFile = await fetch(env.base + '/.env'); assert.equal(secretFile.status, 404);
  const sourceFile = await fetch(env.base + '/server/config.mjs'); assert.equal(sourceFile.status, 404);
  const malformed = await fetch(env.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' });
  assert.equal(malformed.status, 400);
  const html = await fetch(env.base + '/');
  assert.equal(html.status, 200); assert.match(html.headers.get('content-security-policy'), /script-src 'self'/);
});

test('authentication attempts are rate limited', async t => {
  const env = await serve(t);
  for (let i = 0; i < 15; i++) await env.request('/api/auth/login', { email: 'invalid' });
  assert.equal((await env.request('/api/auth/login', { email: 'invalid' })).status, 429);
});

test('profile, preference, tool history and search endpoints preserve account boundaries',async t => {
  const env = await serve(t);const {cookie} = await env.register('ecosystem@example.com');
  assert.equal((await env.request('/api/profiles',{...profile,language:'Kannada',level:'A1',goal:'Learn Kannada',teachingStyle:'socratic'},cookie)).status,200);
  assert.equal((await env.request('/api/profiles',undefined,cookie)).body.profiles.length,2);
  assert.equal((await env.request('/api/profiles/select',{language:'Kannada'},cookie)).body.profile.level,'A1');
  assert.equal((await env.request('/api/profiles/select',{language:'Spanish'},cookie)).body.profile.level,'A2');
  assert.equal((await env.request('/api/preferences',{theme:'dark',translationTarget:'Kannada',learnFromTools:false},cookie)).body.preferences.theme,'dark');
  assert.equal((await env.request('/api/preferences',{theme:'invalid'},cookie)).status,400);
  const translated = await env.request('/api/tools/translate',{text:'Hello!',sourceLanguage:'English',targetLanguage:'Kannada',learn:false},cookie);
  assert.equal(translated.status,200);assert.ok(translated.body.toolResult.text);
  const dashboard = await env.request('/api/dashboard',undefined,cookie);
  assert.equal(dashboard.body.toolHistory.length,1);assert.equal(dashboard.body.preferences.translationTarget,'Kannada');
  const search = await env.request('/api/search?q=Kannada',undefined,cookie);
  assert.ok(search.body.results.some(result => result.type === 'profile' && result.language === 'Kannada'));
  await env.request('/api/workflows/conversation',{message:'Yo tener café'},cookie);
  assert.ok((await env.request('/api/search?q=coffee',undefined,cookie)).body.results.some(result => result.type === 'word'));
  const other = await env.register('other-ecosystem@example.com');
  assert.equal((await env.request('/api/dashboard',undefined,other.cookie)).body.toolHistory.length,0);
  assert.equal((await env.request('/api/search?q=coffee',undefined,other.cookie)).body.results.some(result => result.type === 'word'),false);
  const generated = await env.request('/api/workflows/createActivity',{kind:'quiz'},cookie);
  assert.equal((await env.request(`/api/activity?id=${generated.body.activity.id}`,undefined,other.cookie)).status,404);
});

test('speech-to-text can use configured speech independently of an AI provider',async t => {
  const env = await serve(t,true);const {cookie} = await env.register('transcript@example.com');
  env.speech.status = () => ({configured:true,provider:'test-speech'});
  env.speech.transcribe = async () => ({transcript:'Actual test transcript.',durationSeconds:2,pronunciation:null,source:'test-speech',limitation:'No pronunciation measured.'});
  const result = await env.request('/api/tools/stt',{audioBase64:wav().toString('base64'),sourceLanguage:'English'},cookie);
  assert.equal(result.status,200);assert.equal(result.body.toolResult.text,'Actual test transcript.');
  assert.deepEqual(result.body.outputs,{});assert.equal(env.provider.calls.length,0);
  const dashboard = await env.request('/api/dashboard',undefined,cookie);
  assert.equal(dashboard.body.runs[0].steps.length,1);assert.equal(dashboard.body.runs[0].steps[0].agent,'speechService');
  assert.equal(dashboard.body.stats.sessions,0);
});

test('OCR-dependent requests require configuration and native TTS is not faked on the server',async t => {
  const env = await serve(t);const {cookie} = await env.register('ocr-gating@example.com');
  const pdf = await env.request('/api/tools/documents',{filename:'sample.pdf',fileBase64:Buffer.from('%PDF-1.7\n').toString('base64')},cookie);
  assert.equal(pdf.status,503);assert.equal(pdf.body.error.code,'OCR_NOT_CONFIGURED');
  assert.equal((await env.request('/api/tools/tts',{text:'hello'},cookie)).status,400);
  assert.equal(env.provider.calls.length,0);
});
