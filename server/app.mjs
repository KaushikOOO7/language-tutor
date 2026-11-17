import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { AppError, publicError } from './errors.mjs';
import { authenticate, requireUser, passwordRecord, verifyPassword, createSession, logout, RateLimiter } from './auth.mjs';
import { languages, levels, activityKinds } from './config.mjs';
import { agents } from './agents/definitions.mjs';
import { publicActivity } from './database.mjs';
import { validateWav } from './ai/speech.mjs';
import { languageCatalog, languageMap, scriptNames } from '../public/languages.js';
import { toolCatalog, learningResources } from '../public/catalog.js';
import { toolInput } from './tools/input.mjs';

const publicDir = resolve('public');
const mimeTypes = { '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.svg': 'image/svg+xml', '.webmanifest': 'application/manifest+json' };

function textField(value, label, max = 3000, min = 1) {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max) throw new AppError(400, 'INVALID_INPUT', `${label} must contain ${min} to ${max} characters.`);
  return value.trim();
}
function profileInput(body) {
  if (!Object.hasOwn(languages, body.language) || !Object.hasOwn(languages, body.nativeLanguage) || !levels.includes(body.level)) {
    throw new AppError(400, 'INVALID_PROFILE', 'Choose a supported target language, native language, and CEFR level.');
  }
  if (!Number.isInteger(body.dailyMinutes) || body.dailyMinutes < 5 || body.dailyMinutes > 120) throw new AppError(400, 'INVALID_PROFILE', 'Daily practice time must be between 5 and 120 minutes.');
  const accent = body.accent || languageMap[body.language].locale;
  if (!languageMap[body.language].variants.includes(accent)) throw new AppError(422, 'ACCENT_UNSUPPORTED', 'Choose a listed regional locale for this language. Speech support depends on the provider.');
  return { language: body.language, nativeLanguage: body.nativeLanguage, level: body.level, goal: textField(body.goal, 'Learning goal', 500), dailyMinutes: body.dailyMinutes,
    accent, dialect: body.dialect ? textField(body.dialect, 'Regional preference', 100) : '',
    teachingStyle:['supportive','direct','socratic'].includes(body.teachingStyle) ? body.teachingStyle : 'supportive',
    trainingFocus:['general','exam','business','travel','culture'].includes(body.trainingFocus) ? body.trainingFocus : 'general' };
}
function preferenceInput(body) {
  const values = {};
  if (body.theme !== undefined) {
    if (!['light','dark','system'].includes(body.theme)) throw new AppError(400, 'INVALID_PREFERENCES', 'Choose light, dark, or system theme.');
    values.theme = body.theme;
  }
  for (const key of ['translationSource','translationTarget']) if (body[key] !== undefined) {
    if (!(key === 'translationSource' && body[key] === 'Auto') && !Object.hasOwn(languageMap, body[key])) throw new AppError(422, 'LANGUAGE_UNSUPPORTED', 'Choose a supported translation language.');
    values[key] = body[key];
  }
  if (body.learnFromTools !== undefined) {
    if (typeof body.learnFromTools !== 'boolean') throw new AppError(400, 'INVALID_PREFERENCES', 'Learning preference must be true or false.');
    values.learnFromTools = body.learnFromTools;
  }
  return values;
}
async function readJSON(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) throw new AppError(415, 'JSON_REQUIRED', 'Send this request as application/json.');
  const chunks = []; let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > 12_000_000) { request.resume(); throw new AppError(413, 'REQUEST_TOO_LARGE', 'This request is too large. Upload a file up to 8 MB or record up to 60 seconds.'); }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch { throw new AppError(400, 'INVALID_JSON', 'Send a valid JSON object.'); }
}
function workflowInput(workflow, body) {
  const durationSeconds = Math.min(3600, Math.max(0, Number.isFinite(body.durationSeconds) ? Math.round(body.durationSeconds) : 0));
  if (workflow === 'conversation') return { message: textField(body.message, 'Message', 4000), durationSeconds };
  if (workflow === 'createActivity') {
    if (!['lesson', 'quiz', 'reading', 'writing', 'listening', 'speaking'].includes(body.kind)) throw new AppError(400, 'INVALID_ACTIVITY_KIND', 'Choose lesson, quiz, reading, writing, listening, or speaking. Conversation and vocabulary have their own workflows.');
    return { kind: body.kind, focus: body.focus ? textField(body.focus, 'Activity focus', 500) : undefined };
  }
  if (workflow === 'assessActivity') return { activityId: textField(body.activityId, 'Activity ID', 100),
    answers: body.answers, text: body.text ? textField(body.text, 'Response', 6000) : undefined, durationSeconds };
  if (workflow === 'review') return { wordId: textField(body.wordId, 'Word ID', 100), rating: body.rating, durationSeconds };
  if (workflow === 'speaking') {
    const base64 = textField(body.audioBase64, 'Audio recording', 2_600_000);
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64) || base64.length % 4) throw new AppError(400, 'INVALID_AUDIO', 'The recording must contain valid base64 WAV audio.');
    const audio = Buffer.from(base64, 'base64'); validateWav(audio);
    return { activityId: textField(body.activityId, 'Activity ID', 100), audio };
  }
  if (['plan', 'progress'].includes(workflow)) return {};
  throw new AppError(400, 'UNKNOWN_WORKFLOW', 'This learning workflow is not supported.');
}
function redactResults(result) {
  const out = { ...result };
  for (const id of Object.keys(agents)) {
    if (!out[id]) continue;
    const { memory, ...safe } = out[id];
    if (id === 'grammar') safe.exercises = safe.exercises.map(({ prompt, options }) => ({ prompt, options }));
    out[id] = safe;
  }
  delete out.content;
  return out;
}

export function createApplication({ config, repository: repo, ai, speech, orchestrator, translation = orchestrator.services.translation, ocr = orchestrator.services.ocr }) {
  const limiter = new RateLimiter();
  const allowedOrigins = new Set([config.origin]);
  if (!config.secureCookie && ['127.0.0.1', 'localhost'].includes(config.host)) {
    allowedOrigins.add(`http://127.0.0.1:${config.port}`); allowedOrigins.add(`http://localhost:${config.port}`);
  }
  const send = (response, status, body) => {
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(body));
  };
  const server = createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Permissions-Policy', 'microphone=(self), camera=(self)');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://localhost');
      const path = url.pathname;
      const method = request.method;
      if (path.startsWith('/api/')) {
        if (!['GET', 'POST'].includes(method)) throw new AppError(405, 'METHOD_NOT_ALLOWED', 'This HTTP method is not supported.');
        if (method === 'POST' && ((request.headers.origin && !allowedOrigins.has(request.headers.origin)) || request.headers['sec-fetch-site'] === 'cross-site')) {
          throw new AppError(403, 'INVALID_ORIGIN', 'This request must come from the Language Tutor app.');
        }
        if (method === 'GET' && path === '/api/status') {
          const capabilities = { ai:ai.status(), speech:speech.status(), translation:translation.status(), ocr:ocr.status() };
          send(response, 200, { ...capabilities, languages: Object.keys(languages), languageCatalog, scriptNames, levels, activityKinds,
            tools:toolCatalog.map(tool => ({ ...tool, ready:tool.needs.every(name => capabilities[name]?.configured) })), resources:learningResources,
            agents: Object.entries(agents).map(([id, agent]) => ({ id, name: agent.name, description: agent.description })) });
          return;
        }
        if (method === 'GET' && path === '/api/session') {
          const id = authenticate(repo, request);
          send(response, 200, { user: id ? repo.user(id) : null, profile: id ? repo.profile(id) : null, preferences:id ? repo.preferences(id) : null }); return;
        }
        if (method === 'POST' && ['/api/auth/register', '/api/auth/login'].includes(path)) {
          limiter.take(`auth:${request.socket.remoteAddress}`, 15, 15 * 60000);
          const body = await readJSON(request);
          const email = textField(body.email, 'Email', 254).toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new AppError(400, 'INVALID_EMAIL', 'Enter a valid email address.');
          if (typeof body.password !== 'string' || body.password.length < 10 || body.password.length > 128) throw new AppError(400, 'INVALID_PASSWORD', 'Use a password with 10 to 128 characters.');
          let user;
          if (path.endsWith('/register')) {
            const profile = profileInput(body);
            const name = textField(body.name, 'Name', 60);
            const record = await passwordRecord(body.password);
            try { user = repo.createUser({ email, name, profile, ...record }); }
            catch (error) {
              if (String(error.message).includes('UNIQUE')) throw new AppError(409, 'ACCOUNT_EXISTS', 'An account with this email already exists. Sign in to continue.');
              throw error;
            }
          } else {
            const found = repo.userByEmail(email);
            if (!await verifyPassword(body.password, found)) throw new AppError(401, 'INVALID_CREDENTIALS', 'The email or password is incorrect.');
            user = repo.user(found.id);
          }
          createSession(repo, user.id, response, config.secureCookie);
          send(response, 200, { user, profile: repo.profile(user.id) }); return;
        }
        if (method === 'POST' && path === '/api/auth/logout') {
          logout(repo, request, response, config.secureCookie); send(response, 200, { ok: true }); return;
        }
        const userId = requireUser(repo, request);
        const profile = repo.profile(userId);
        if (method === 'GET' && path === '/api/dashboard') {
          const plan = repo.plan(userId, profile.language);
          if (plan) delete plan.memory;
          send(response, 200, { user: repo.user(userId), profile, stats: repo.stats(userId, profile.language),
            vocabulary: repo.vocabulary(userId, profile.language), plan,
            insights: repo.insights(userId, profile.language),
            profiles:repo.profiles(userId), preferences:repo.preferences(userId), toolHistory:repo.toolHistory(userId),
            conversation: repo.conversation(userId, profile.language), activity: publicActivity(repo.latestActivity(userId, profile.language)),
            attempts: repo.attempts(userId, profile.language).map(row => ({ ...row, result: redactResults(row.result) })),
            runs: repo.runs(userId) }); return;
        }
        if (method === 'GET' && path === '/api/runs') { send(response, 200, { runs: repo.runs(userId) }); return; }
        if (method === 'GET' && path === '/api/profiles') { send(response,200,{ profiles:repo.profiles(userId), activeLanguage:profile.language }); return; }
        if (method === 'POST' && path === '/api/profiles') { send(response,200,{ profile:repo.addProfile(userId,profileInput(await readJSON(request))) }); return; }
        if (method === 'POST' && path === '/api/profiles/select') {
          const body = await readJSON(request); send(response,200,{ profile:repo.selectProfile(userId,textField(body.language,'Language',100)) }); return;
        }
        if (method === 'POST' && path === '/api/preferences') { send(response,200,{ preferences:repo.updatePreferences(userId,preferenceInput(await readJSON(request))) }); return; }
        if (method === 'GET' && path === '/api/search') {
          const query = textField(url.searchParams.get('q'),'Search query',120).toLowerCase();
          const results = [...toolCatalog.filter(tool => `${tool.name} ${tool.description} ${tool.category}`.toLowerCase().includes(query)).map(tool => ({ type:'tool',id:tool.id,title:tool.name,description:tool.description,route:'tools' })),
            ...learningResources.filter(resource => `${resource.title} ${resource.description} ${resource.tags.join(' ')}`.toLowerCase().includes(query)).map(resource => ({ type:'resource',id:resource.id,title:resource.title,description:resource.description,route:'practice' })),
            ...repo.profiles(userId).filter(item => `${item.language} ${languageMap[item.language]?.native}`.toLowerCase().includes(query)).map(item => ({ type:'profile',id:item.language,title:`${item.language} learning profile`,description:`${item.level} · ${item.goal}`,route:'profile',language:item.language })),
            ...repo.search(userId,query)].slice(0,40);
          send(response,200,{ results }); return;
        }
        if (method === 'GET' && path === '/api/activity') {
          const language = url.searchParams.get('language') || profile.language;
          const id = textField(url.searchParams.get('id'),'Activity ID',100);
          send(response,200,{ activity:publicActivity(repo.activity(userId,language,id)) }); return;
        }
        if (method === 'POST' && path === '/api/profile') {
          const input = profileInput(await readJSON(request));
          send(response, 200, { profile: repo.updateProfile(userId, input) }); return;
        }
        if (method === 'POST' && (path.startsWith('/api/workflows/') || path.startsWith('/api/tools/'))) {
          limiter.take(`workflow:${userId}`, 60, 3600000);
          const isTool = path.startsWith('/api/tools/');
          const workflow = isTool ? 'tool' : path.slice('/api/workflows/'.length);
          const body = await readJSON(request);
          const input = isTool ? toolInput(path.slice('/api/tools/'.length),body,profile) : workflowInput(workflow,body);
          const controller = new AbortController();
          const cancel = () => { if (!response.writableEnded) controller.abort(); };
          response.once('close', cancel);
          try { send(response, 200, await orchestrator.execute(userId, workflow, input, controller.signal)); }
          finally { response.off('close', cancel); }
          return;
        }
        throw new AppError(404, 'NOT_FOUND', 'This endpoint was not found.');
      }
      if (!['GET', 'HEAD'].includes(method)) throw new AppError(405, 'METHOD_NOT_ALLOWED', 'This HTTP method is not supported.');
      const asset = path === '/' ? 'index.html' : decodeURIComponent(path).replace(/^\/+/, '');
      const target = resolve(publicDir, asset);
      if (!target.startsWith(publicDir + sep) || !mimeTypes[extname(target)]) throw new AppError(404, 'NOT_FOUND', 'This page was not found.');
      let contents;
      try { contents = await readFile(target); }
      catch { throw new AppError(404, 'NOT_FOUND', 'This page was not found.'); }
      response.writeHead(200, { 'Content-Type': mimeTypes[extname(target)], 'Cache-Control': 'no-cache' });
      response.end(method === 'HEAD' ? undefined : contents);
    } catch (error) {
      const visible = publicError(error);
      if (!(error instanceof AppError)) console.error('Request failed:', error?.code || error?.name || 'UnknownError');
      if (!response.headersSent && !response.destroyed) send(response, visible.status, { error: { code: visible.code, message: visible.message } });
    }
  });
  server.requestTimeout = 300000;
  server.headersTimeout = 15000;
  return server;
}
