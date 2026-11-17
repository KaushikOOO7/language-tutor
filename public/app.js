import { sample } from './demo.js';
import { renderShell, routes, escapeHTML as e } from './views.js';
import { icon } from './icons.js';
import { Recorder, speak } from './audio.js';
import { routeTools, routeFor, languageOptions } from './eco-views.js';
import { toolCatalog, learningResources } from './catalog.js';
import { languageMap } from './languages.js';

const app = document.querySelector('#app');
const modal = document.querySelector('#modal');
const state = {
  route: routes[location.hash.slice(1)] ? location.hash.slice(1) : 'dashboard',
  data: structuredClone(sample), status: { ai: { configured: false }, speech: { configured: false }, agents: [] },
  demo: true, busy: false, practiceKind: 'lesson', result: null, flashRevealed: false, mobileOpen: false,
  error: null, draft: '', recording: false, audioBase64: null,
  selectedTool:null, toolDraft:null, toolResult:null, toolUpload:null, toolAudioBase64:null, toolConversationId:null, searchResults:[],
};
state.selectedTool = routeTools[state.route] || null;
let cameraStream;
const systemTheme = matchMedia('(prefers-color-scheme: dark)');
function applyTheme() {
  const choice = (state.demo ? localStorage.getItem('lingua-theme') : state.data.preferences?.theme) || localStorage.getItem('lingua-theme') || 'system';
  state.theme = choice === 'system' ? systemTheme.matches ? 'dark' : 'light' : choice;
  document.documentElement.dataset.theme = state.theme;
}
systemTheme.addEventListener('change', () => { applyTheme(); render(); });
let visibleStarted = document.hidden ? null : Date.now();
let visibleSeconds = 0;
const recorder = new Recorder();
const elapsed = () => Math.min(3600, Math.round(visibleSeconds + (visibleStarted ? (Date.now() - visibleStarted) / 1000 : 0)));
function resetTimer() { visibleSeconds = 0; visibleStarted = document.hidden ? null : Date.now(); }
document.addEventListener('visibilitychange', () => {
  if (document.hidden && visibleStarted) { visibleSeconds += (Date.now() - visibleStarted) / 1000; visibleStarted = null; }
  else if (!document.hidden) visibleStarted = Date.now();
});
let toastTimer;
function toast(message) {
  const element = document.querySelector('#toast'); element.textContent = message; element.classList.add('visible');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => element.classList.remove('visible'), 5500);
}
async function api(path, body) {
  let response;
  try { response = await fetch(path, { method: body === undefined ? 'GET' : 'POST', credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) }); }
  catch { throw new Error('The app server could not be reached. Check that it is running and try again.'); }
  let result;
  try { result = await response.json(); } catch { throw new Error('The app server returned an unreadable response.'); }
  if (!response.ok) {
    const error = new Error(result.error?.message || 'This request could not be completed.');
    error.code = result.error?.code; error.status = response.status; throw error;
  }
  return result;
}
function render() {
  applyTheme();
  app.innerHTML = renderShell(state);
  const video = document.querySelector('#camera-feed'); if (video && cameraStream) video.srcObject = cameraStream;
  const messages = document.querySelector('#chat-messages');
  if (messages) messages.scrollTop = messages.scrollHeight;
}
async function refresh() {
  const previousUserId = state.data.user?.id;
  const session = await api('/api/session');
  state.demo = !session.user;
  if (session.user) {
    if (previousUserId && previousUserId !== session.user.id) resetPrivateState();
    state.data = await api('/api/dashboard');
    if (!state.result && state.data.activity?.completedAt) {
      const attempt = state.data.attempts.find(item => item.activityId === state.data.activity.id);
      if (attempt) state.result = { language:state.data.profile.language, outputs: attempt.result, speechEvidence: attempt.result.speechEvidence,
        objectiveResults: attempt.result.objectiveResults, ...(attempt.result.objectiveResults ? { score: attempt.score } : {}) };
    }
  }
  else { resetPrivateState(); state.data = structuredClone(sample); }
}
function resetPrivateState() {
  state.result = null; state.completedActivityId = null; state.toolResult = null; state.toolDraft = null;
  state.toolUpload = null; state.toolAudioBase64 = null; state.audioBase64 = null; state.toolConversationId = null; state.draft = ''; state.searchResults = [];
  closeCamera();
}
function navigate(route) {
  if (state.busy || state.recording || state.recordingPending || state.uploadPending || state.cameraPending) { toast('Finish the current activity before moving to another page.'); return; }
  state.route = route; state.mobileOpen = false; state.error = null; location.hash = route; resetTimer();
  closeCamera();
  state.selectedTool = routeTools[route] || null; render();
  window.scrollTo({ top: 0, behavior: 'instant' });
}
window.addEventListener('hashchange', () => {
  const route = location.hash.slice(1);
  if (routes[route] && route !== state.route) {
    if (state.busy || state.recording || state.recordingPending) { history.replaceState(null, '', `#${state.route}`); return; }
    navigate(route);
  }
});
function authorize(speech = false) {
  if (state.demo) { showAuth('register'); return false; }
  if (!state.status.ai.configured || (speech && !state.status.speech.configured)) { showSetup(); return false; }
  return true;
}
function authorizeTool(id, filename) {
  const tool = toolCatalog.find(tool => tool.id === id);
  if (id === 'tts') return true;
  if (state.demo) { showAuth(); return false; }
  const needs = [...(tool?.needs || [])];
  if (filename && /\.pdf$/i.test(filename)) needs.push('ocr');
  if (needs.some(need => !state.status[need]?.configured)) { showSetup(); return false; }
  return true;
}
async function runWorkflow(workflow, input = {}) {
  if (state.busy || state.recording || state.recordingPending || !(workflow === 'tool' ? authorizeTool(input.tool,input.filename) : authorize(workflow === 'speaking'))) return null;
  state.busy = true; state.error = null; render();
  let polling = false;
  const poll = async () => {
    if (polling) return; polling = true;
    try {
      const { runs } = await api('/api/runs');
      if (!state.busy) return;
      state.data.runs = runs;
      const active = runs.find(run => run.status === 'running');
      const running = active?.steps.filter(step => step.status === 'running') || [];
      const text = document.querySelector('#busy-text');
      if (text && running.length) text.textContent = `Running: ${running.map(step => ({ speechService:'speech recognition', ocrService:'text extraction', documentParser:'reading document', websiteReader:'reading web text', translationService:'translation service' })[step.agent] || state.status.agents.find(agent => agent.id === step.agent)?.name || step.agent).join(' + ')}…`;
      for (const element of document.querySelectorAll('[data-agent-status]')) {
        element.textContent = running.some(step => step.agent === element.dataset.agentStatus) ? 'Running in current workflow' : 'Available for live workflows';
      }
    } catch { /* The workflow request owns error reporting; avoid poll-driven duplicate errors. */ }
    finally { polling = false; }
  };
  const timer = setInterval(poll, 1400);
  try {
    const result = await api(workflow === 'tool' ? `/api/tools/${input.tool}` : `/api/workflows/${workflow}`, input);
    state.result = result;
    if (workflow === 'tool') {
      state.toolResult = { ...result, tool:input.tool };
      if (result.toolResult?.conversationId) state.toolConversationId = result.toolResult.conversationId;
    }
    await refresh();
    if (result.activity && result.language === state.data.profile.language) { state.data.activity = result.activity; state.practiceKind = input.kind === 'quiz' && state.practiceKind === 'grammar' ? 'grammar' : result.activity.kind; state.completedActivityId = null; }
    if (result.outputs?.progress && result.language === state.data.profile.language) state.data.insights = result.outputs.progress;
    if (workflow === 'conversation') state.draft = '';
    if (['assessActivity', 'speaking'].includes(workflow)) state.completedActivityId = input.activityId;
    if (workflow === 'review') state.flashRevealed = false;
    resetTimer(); return result;
  } catch (error) {
    state.error = error.message;
    if (error.status === 401) { resetPrivateState(); state.demo = true; state.data = structuredClone(sample); showAuth('login'); }
    return null;
  } finally {
    clearInterval(timer); state.busy = false;
    if (!state.demo) {
      try { state.data.runs = (await api('/api/runs')).runs; } catch { /* Preserve the main request error. */ }
    }
    render();
  }
}
async function generate(kind = state.practiceKind, focus = '') {
  if (state.recording || state.recordingPending) { toast('Stop your recording before creating another activity.'); return; }
  if (kind === 'conversation') { if (authorize()) navigate('conversation'); return; }
  if (kind === 'vocabulary') { if (authorize()) navigate('vocabulary'); return; }
  if (!authorize()) return;
  state.practiceKind = kind; state.result = null; state.completedActivityId = null; state.audioBase64 = null; state.activityAnswers = []; state.writingDraft = '';
  navigate('practice');
  const actualKind = kind === 'grammar' ? 'quiz' : kind;
  await runWorkflow('createActivity', { kind: actualKind, focus: focus || (kind === 'grammar' ? 'Grammar patterns from my recent mistakes' : undefined) });
}

function modalHeader(title, description) {
  return `<div class="modal-header"><h2>${e(title)}</h2><button class="icon-button" data-action="close-modal" aria-label="Close dialog">${icon('close')}</button></div><p class="modal-description">${e(description)}</p>`;
}
function openModal(html) {
  modal.innerHTML = html;
  modal.setAttribute('aria-label',modal.querySelector('h2')?.textContent || 'Language options');
  if (!modal.open) modal.showModal();
}
function profileFields(profile = { language: 'Spanish', nativeLanguage: 'English', level: 'A2', dailyMinutes: 20, goal: 'Feel confident in everyday conversations and travel.' }) {
  const options = (values, selected) => values.map(value => `<option value="${e(value)}" ${value === selected ? 'selected' : ''}>${e(value)}</option>`).join('');
  const languages = state.status.languages || ['Spanish', 'English'];
  return `<div class="form-grid"><div class="form-field"><label for="language">I’m learning</label><select id="language" name="language">${languageOptions(profile.language)}</select></div><div class="form-field"><label for="native-language">Explain things in</label><select id="native-language" name="nativeLanguage">${languageOptions(profile.nativeLanguage)}</select></div><div class="form-field"><label for="level">My current level</label><select id="level" name="level">${options(state.status.levels || ['A1','A2','B1','B2','C1','C2'],profile.level)}</select></div><div class="form-field"><label for="daily-minutes">Daily goal (minutes)</label><input id="daily-minutes" name="dailyMinutes" type="number" min="5" max="120" value="${profile.dailyMinutes}" required></div></div><div class="form-field" style="margin-top:16px"><label for="goal">What would you like to achieve?</label><textarea id="goal" name="goal" rows="2" maxlength="500" required>${e(profile.goal)}</textarea></div><details class="tool-advanced"><summary>Teaching style, region, and learning focus</summary><div class="form-grid"><div class="form-field"><label for="accent">Regional locale</label><select id="accent" name="accent">${options((languageMap[profile.language]?.variants || []).map(locale => locale),profile.accent || languageMap[profile.language]?.locale)}</select></div><div class="form-field"><label for="teaching-style">Teaching style</label><select id="teaching-style" name="teachingStyle">${options(['supportive','direct','socratic'],profile.teachingStyle || 'supportive')}</select></div><div class="form-field"><label for="training-focus">Learning focus</label><select id="training-focus" name="trainingFocus">${options(['general','exam','business','travel','culture'],profile.trainingFocus || 'general')}</select></div><div class="form-field"><label for="dialect">Dialect / regional preference</label><input id="dialect" name="dialect" maxlength="100" value="${e(profile.dialect || '')}" placeholder="Optional regional expressions"></div></div><p class="feature-note">Text teaching follows your regional preference when practical. Audio capabilities depend on the provider and installed voices.</p></details>`;
}
function showAuth(mode = 'register') {
  const register = mode === 'register';
  openModal(`${modalHeader(register ? 'Your next chapter starts here.' : 'Welcome back.', register ? 'One account. Every learning tool. A journey your agents adapt to you.' : 'Pick up your personal learning journey.')}<form id="auth-form" data-mode="${mode}">${register ? '<div class="form-field"><label for="name">Your name</label><input id="name" name="name" autocomplete="given-name" maxlength="60" required></div>' : ''}<div class="form-field"><label for="email">Email address</label><input id="email" name="email" type="email" autocomplete="email" maxlength="254" required></div><div class="form-field"><label for="password">Password · at least 10 characters</label><input id="password" name="password" type="password" autocomplete="${register ? 'new-password' : 'current-password'}" minlength="10" maxlength="128" required></div>${register ? profileFields() : ''}<p class="form-error" id="form-error" role="alert"></p><button class="btn form-submit" type="submit">${register ? 'Create my learning space' : 'Sign in'} ${icon('arrow')}</button></form><p class="auth-switch">${register ? 'Already have an account?' : 'New here?'} <button data-action="auth-mode" data-mode="${register ? 'login' : 'register'}">${register ? 'Sign in' : 'Create an account'}</button></p>${!state.status.ai.configured ? '<p class="small muted" style="margin-top:16px">Account creation is available. Live learning requires your server administrator to configure an AI provider.</p>' : ''}`);
}
function showSettings() {
  if (state.recording || state.recordingPending) { toast('Stop your recording before changing learning preferences.'); return; }
  if (state.demo) { showAuth(); return; }
  openModal(`${modalHeader('Make it your journey.', 'Your agents use these preferences to adapt the difficulty, focus, and pace.')}<form id="settings-form">${profileFields(state.data.profile)}<p class="small muted">Each target language keeps its own preferences and learning history. All tools remain available at every level.</p><p class="form-error" id="form-error" role="alert"></p><button class="btn form-submit" type="submit">Save my preferences</button></form><div class="row-actions" style="margin-top:20px">${buttonHTML('Provider setup','setup')}${buttonHTML('Add language','add-language')}${buttonHTML('Sign out','logout')}</div>`);
}
function buttonHTML(label, action) { return `<button class="btn btn-ghost" data-action="${action}">${label}</button>`; }
function showLanguagePicker() {
  if (state.demo) { showAuth(); return; }
  openModal(`${modalHeader('Choose your learning language.','Each language keeps its own goals, vocabulary, and progress.')}<div class="language-picker-list">${state.data.profiles.map(profile => `<button class="language-picker-item" data-action="switch-language" data-language="${e(profile.language)}"><span class="language-dot">${e(profile.language.slice(0,2).toUpperCase())}</span><strong>${e(profile.language)}</strong><span class="small">${e(profile.level)}${profile.language === state.data.profile.language ? ' · Current' : ''}</span></button>`).join('')}</div><div style="margin-top:20px">${buttonHTML('Add another language','add-language')}</div>`);
}
function showAddLanguage() {
  if (state.demo) { showAuth(); return; }
  openModal(`${modalHeader('Add another language.','Your existing learning journeys stay saved.')}<form id="add-language-form">${profileFields({ language:'Kannada',nativeLanguage:state.data.profile.nativeLanguage,level:'A1',dailyMinutes:20,goal:'Build confidence in everyday communication.' })}<label class="checkbox-label"><input name="activate" type="checkbox" checked>Switch to this language after adding</label><p class="form-error" id="form-error" role="alert"></p><button class="btn form-submit" type="submit">Save language profile</button></form>`);
}
function showTranslationPreferences() {
  if (state.demo) { showAuth(); return; }
  const preferences = state.data.preferences;
  openModal(`${modalHeader('Your translation defaults.','Choose the languages and learning options you use most often.')}<form id="translation-preferences-form"><div class="form-field"><label for="default-source">Translate from</label><select id="default-source" name="translationSource">${languageOptions(preferences.translationSource,true)}</select></div><div class="form-field"><label for="default-target">Translate into</label><select id="default-target" name="translationTarget">${languageOptions(preferences.translationTarget)}</select></div><label class="checkbox-label"><input name="learnFromTools" type="checkbox" ${preferences.learnFromTools ? 'checked' : ''}>Offer vocabulary and practice with tool results</label><div class="form-field" style="margin-top:20px"><label for="theme-choice">Appearance</label><select id="theme-choice" name="theme">${['system','light','dark'].map(theme => `<option ${preferences.theme === theme ? 'selected' : ''}>${theme}</option>`).join('')}</select></div><p class="form-error" id="form-error" role="alert"></p><button class="btn form-submit" type="submit">Save preferences</button></form>`);
}
async function switchLanguage(language) {
  await api('/api/profiles/select',{ language });
  state.result = null; state.completedActivityId = null; state.audioBase64 = null;
  await refresh(); modal.close(); render(); resetTimer();
}
function currentToolResult() {
  const id = state.selectedTool || routeTools[state.route];
  return (state.toolResult?.tool === id ? state.toolResult.toolResult : null) || state.data.toolHistory?.find(item => item.tool === id)?.result;
}
function openTool(id) {
  if (state.busy || state.recording || state.recordingPending || state.uploadPending || state.cameraPending) { toast('Finish your current activity first.'); return; }
  const draft = state.toolDraft;
  navigate(routeFor(id)); state.selectedTool = id; state.toolResult = null; state.toolDraft = null; state.toolUpload = null; state.toolAudioBase64 = null;
  if (id === 'live-conversation' && draft?.sourceLanguage && draft?.targetLanguage) state.toolDraft = { sourceLanguage:draft.sourceLanguage,targetLanguage:draft.targetLanguage,learn:false };
  render();
}
function closeCamera() {
  cameraStream?.getTracks().forEach(track => track.stop()); cameraStream = null; state.cameraActive = false;
}
async function handleEcosystemAction(action,target) {
  if (state.busy && ['switch-language','add-language','search-result','new-translation-conversation','all-tools','learning-resource','open-tool-practice','tool-skill-practice'].includes(action)) { toast('Wait for the current workflow to finish.'); return true; }
  if (action === 'language-picker') showLanguagePicker();
  else if (action === 'add-language') showAddLanguage();
  else if (action === 'translation-preferences') showTranslationPreferences();
  else if (action === 'switch-language') { if (state.demo) showAuth(); else await switchLanguage(target.dataset.language); }
  else if (action === 'toggle-theme') {
    const theme = state.theme === 'dark' ? 'light' : 'dark'; localStorage.setItem('lingua-theme',theme);
    state.data.preferences = { ...state.data.preferences,theme }; render();
    if (!state.demo) { try { await api('/api/preferences',{ theme }); } catch { toast('Theme changed on this device; account preferences could not be saved.'); } }
  }
  else if (action === 'open-tool') openTool(target.dataset.tool);
  else if (action === 'all-tools') { navigate('tools'); state.selectedTool = null; state.toolResult = null; render(); }
  else if (action === 'tool-category') { state.toolCategory = target.dataset.category; render(); }
  else if (action === 'open-path') navigate('path');
  else if (action === 'learning-resource') { const resource = learningResources.find(item => item.id === target.dataset.resource); if (resource) await generate(resource.kind,resource.focus); }
  else if (action === 'search') showSearch();
  else if (action === 'search-result') {
    const result = state.searchResults[Number(target.dataset.index)]; if (!result) return true;
    modal.close();
    if (result.type === 'tool') openTool(result.id);
    else if (result.type === 'resource') { const resource = learningResources.find(item => item.id === result.id); if (resource) await generate(resource.kind,resource.focus); }
    else {
      if (result.language && result.language !== state.data.profile.language) await switchLanguage(result.language);
      navigate(result.route);
      if (result.type === 'lesson') { const saved = await api(`/api/activity?id=${encodeURIComponent(result.id)}&language=${encodeURIComponent(result.language)}`); state.data.activity = saved.activity; state.practiceKind = saved.activity.kind; render(); }
      if (result.type === 'word') { const search = document.querySelector('#word-search'); if (search) { search.value = result.title; search.dispatchEvent(new Event('input',{ bubbles:true })); } }
    }
  }
  else if (action === 'new-translation-conversation') { state.toolConversationId = null; state.toolResult = null; state.toolDraft = { ...state.toolDraft,text:'',learn:false }; toast('The next turn will start a new conversation.'); render(); }
  else if (action === 'open-tool-practice') {
    const result = currentToolResult(); if (!result?.practiceActivityId) return true;
    if (state.data.profile.language !== result.targetLanguage) await switchLanguage(result.targetLanguage);
    const saved = await api(`/api/activity?id=${encodeURIComponent(result.practiceActivityId)}&language=${encodeURIComponent(result.targetLanguage)}`);
    state.data.activity = saved.activity; state.practiceKind = saved.activity.kind; navigate('practice');
  }
  else if (action === 'tool-skill-practice') {
    if (!authorize()) return true;
    const language = target.dataset.language || state.data.profile.language;
    if (language !== state.data.profile.language) {
      if (!state.data.profiles.some(profile => profile.language === language)) await api('/api/profiles',{ ...state.data.profile,language,accent:languageMap[language].locale,level:'A1',goal:`Practice ${language} communication.` });
      await switchLanguage(language);
    }
    await generate(target.dataset.kind,target.dataset.focus);
  }
  else if (action === 'listen-tool-result') { const result = currentToolResult(); if (result) speak(result.text,result.targetLanguage); }
  else if (action === 'stop-voice') speechSynthesis.cancel();
  else if (action === 'copy-tool-result') { if (!navigator.clipboard?.writeText) throw new Error('Clipboard access is unavailable. Select and copy the result text.'); await navigator.clipboard.writeText(currentToolResult()?.text || ''); toast('Copied to clipboard.'); }
  else if (action === 'download-tool-result') {
    const result = currentToolResult(); if (!result) return true;
    const url = URL.createObjectURL(new Blob([result.text],{ type:'text/plain;charset=utf-8' }));
    const link = document.createElement('a'); link.href = url; link.download = `translation-${result.targetLanguage}.txt`; link.click(); setTimeout(() => URL.revokeObjectURL(url),1000);
  }
  else if (action === 'record-tool') {
    const id = state.selectedTool || routeTools[state.route];
    if (!authorizeTool(id) || !state.status.speech.configured) { if (!state.demo) showSetup(); return true; }
    if (state.recordingPending || state.busy) return true;
    if (state.recording) await stopRecording();
    else {
      state.recordMode = 'tool'; state.toolAudioBase64 = null; state.recordingPending = true;
      const form = document.querySelector('#language-tool-form'); if (form) state.toolDraft = toolFormFields(form);
      try { await recorder.start(seconds => { const label = document.querySelector('#record-time'); if (label) label.textContent = `0:${String(seconds).padStart(2,'0')}`; if (seconds >= 60 && state.recording) stopRecording(); }); state.recording = true; }
      finally { state.recordingPending = false; render(); }
    }
  }
  else if (action === 'open-camera') {
    if (!authorizeTool('camera-translate') || state.cameraPending || state.cameraActive) return true;
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Camera capture needs localhost or HTTPS and a supported browser.');
    const form = document.querySelector('#language-tool-form'); if (form) state.toolDraft = toolFormFields(form);
    state.cameraPending = true;
    try { cameraStream = await navigator.mediaDevices.getUserMedia({ video:{ facingMode:'environment' },audio:false }); state.cameraActive = true; }
    finally { state.cameraPending = false; render(); }
  }
  else if (action === 'capture-camera') {
    const video = document.querySelector('#camera-feed');
    if (!video?.videoWidth) throw new Error('Wait for the camera preview before taking a photo.');
    const canvas = document.createElement('canvas'); const scale = Math.min(1,1600 / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
    const preview = canvas.toDataURL('image/png'); state.toolUpload = { filename:'camera-capture.png',fileBase64:preview.split(',')[1],preview };
    closeCamera(); render();
  }
  else if (action === 'close-camera') { closeCamera(); render(); }
  else return false;
  return true;
}
function toolFormFields(form) {
  const fields = Object.fromEntries(new FormData(form));
  fields.learn = form.elements.learn?.checked || false; fields.isHTML = form.elements.isHTML?.checked || false;
  if (!fields.sourceLanguage) fields.sourceLanguage = fields.targetLanguage;
  return fields;
}
let searchVersion = 0;
function showSearch() {
  openModal(`${modalHeader('Find your next step.','Search language tools, learning resources, and your saved words and lessons.')}<div class="search-field">${icon('search')}<input id="universal-search" maxlength="120" placeholder="Try Kannada, grammar, travel, or a saved word…" aria-label="Search your language ecosystem"></div><div class="search-results" id="search-results"></div>`);
  document.querySelector('#universal-search').focus(); updateSearch('');
}
async function updateSearch(query) {
  const version = ++searchVersion; const q = query.trim().toLowerCase();
  const pages = Object.entries(routes).filter(([,entry]) => entry[1].toLowerCase().includes(q)).map(([route,entry]) => ({ type:'page',id:route,route,title:entry[1],description:'Open this page' }));
  let results = [...toolCatalog.filter(tool => `${tool.name} ${tool.description}`.toLowerCase().includes(q)).map(tool => ({ type:'tool',id:tool.id,route:'tools',title:tool.name,description:tool.description })),
    ...learningResources.filter(resource => `${resource.title} ${resource.tags.join(' ')}`.toLowerCase().includes(q)).map(resource => ({ type:'resource',id:resource.id,route:'practice',title:resource.title,description:resource.description })),...pages];
  if (!state.demo && q) {
    try { const saved = await api(`/api/search?q=${encodeURIComponent(q)}`); results = [...saved.results,...pages]; }
    catch { /* Local tool and page results remain available if the search request fails. */ }
  }
  if (version !== searchVersion || !document.querySelector('#search-results')) return;
  state.searchResults = results.slice(0,q ? 40 : 8);
  document.querySelector('#search-results').innerHTML = state.searchResults.length ? state.searchResults.map((result,index) => `<button class="search-result" data-action="search-result" data-index="${index}"><strong>${e(result.title)}</strong><span>${e(result.description)}</span></button>`).join('') : '<p class="small muted">No results yet. Try a tool name, learning topic, or saved word.</p>';
}
function showSetup() {
  openModal(`${modalHeader('Connect your language engine.', 'The server connects your agent team and language services.')}<p class="config-details"><strong>AI agents:</strong> ${state.status.ai.configured ? `Configured with ${e(state.status.ai.provider)} · ${e(state.status.ai.model)}` : 'Not configured'}<br><strong>Speech recognition:</strong> ${state.status.speech.configured ? e(state.status.speech.provider) : 'Not configured'}<br><strong>OCR for images and PDFs:</strong> ${state.status.ocr?.configured ? e(state.status.ocr.provider) : 'Not configured'}<br><strong>Translation:</strong> ${e(state.status.translation?.provider || 'llm')} · model and language coverage vary</p><p class="config-details">On the server, copy <code>.env.example</code> to <code>.env</code>, set your provider credentials and model, then restart the app.</p><pre class="config-code">AI_PROVIDER=openai-compatible
AI_MODEL=your-model-name
AI_API_KEY=your-server-api-key
  AI_BASE_URL=https://api.openai.com/v1</pre><p class="config-details">Anthropic and other compatible providers are supported. For Anthropic, set <code>AI_PROVIDER=anthropic</code> and <code>AI_BASE_URL=https://api.anthropic.com/v1</code>.</p><p class="config-details">For OCR, set <code>OCR_PROVIDER=azure-document-intelligence</code>, <code>OCR_BASE_URL</code>, and <code>OCR_API_KEY</code>. For Azure text translation, set <code>TRANSLATION_PROVIDER=azure</code>, <code>TRANSLATION_API_KEY</code>, and <code>TRANSLATION_REGION</code>.</p><p class="config-details">For measured pronunciation, configure Azure Speech and supported <code>SPEECH_PRONUNCIATION_LOCALES</code>. Short voice translation uses real transcription. Conversation translation is turn-based. Device text-to-speech works when your selected language has an installed voice.</p><p class="small muted">Keys stay on the server. Configuration badges confirm settings are present; provider connectivity and language support are checked when a real request runs.</p>`);
}

document.addEventListener('click', async event => {
  const routeButton = event.target.closest('[data-route]');
  if (routeButton) { navigate(routeButton.dataset.route); return; }
  const target = event.target.closest('[data-action]');
  if (!target || target.disabled) return;
  const action = target.dataset.action;
  try {
    if (['language-picker','add-language','translation-preferences','switch-language','toggle-theme','open-tool','all-tools','tool-category','open-path','learning-resource','search','search-result','new-translation-conversation','open-tool-practice','tool-skill-practice','listen-tool-result','stop-voice','copy-tool-result','download-tool-result','record-tool','open-camera','capture-camera','close-camera'].includes(action)) {
      await handleEcosystemAction(action,target); return;
    }
    if (action === 'close-modal') modal.close();
    else if (action === 'auth') showAuth();
    else if (action === 'auth-mode') showAuth(target.dataset.mode);
    else if (action === 'settings') showSettings();
    else if (action === 'setup') showSetup();
    else if (action === 'menu') { state.mobileOpen = !state.mobileOpen; render(); }
    else if (action === 'team') navigate('agents');
    else if (action === 'practice') navigate('practice');
    else if (action === 'vocabulary') navigate('vocabulary');
    else if (action === 'start-conversation') { if (authorize()) navigate('conversation'); }
    else if (action === 'dismiss-error') { state.error = null; render(); }
    else if (action === 'practice-tab') {
      if (state.recording || state.recordingPending) { toast('Stop your recording first.'); return; }
      state.practiceKind = target.dataset.kind; state.result = null; state.audioBase64 = null; resetTimer(); render();
    }
    else if (action === 'generate') await generate(target.dataset.kind, target.dataset.focus);
    else if (action === 'build-plan') { if (authorize()) { navigate('path'); await runWorkflow('plan'); } }
    else if (action === 'analyze-progress') await runWorkflow('progress');
    else if (action === 'recommended') { const rec = state.data.insights?.recommendation; if (rec) await generate(rec.kind, rec.reason); }
    else if (action === 'reveal') { state.flashRevealed = true; render(); }
    else if (action === 'review') {
      const result = await runWorkflow('review', { wordId: target.dataset.word, rating: target.dataset.rating, durationSeconds: elapsed() });
      if (result) toast(`Saved. Next review: ${new Date(result.nextReviewAt).toLocaleString()}.`);
    }
    else if (action === 'logout') {
      if (state.busy || state.recording) { toast('Finish your current activity first.'); return; }
      await api('/api/auth/logout', {}); modal.close(); await refresh(); state.result = null; navigate('dashboard');
    }
    else if (action === 'listen-activity') speak(state.data.activity.content.listeningText, state.data.profile.language);
    else if (action === 'record') {
      if (state.recordingPending) return;
      if (!authorize(true)) return;
      if (!state.recording) {
        state.recordMode = 'learning';
        state.audioBase64 = null;
        state.recordingPending = true;
        try {
          await recorder.start(seconds => {
            const label = document.querySelector('#record-time'); if (label) label.textContent = `0:${String(seconds).padStart(2, '0')}`;
            if (seconds >= 60 && state.recording) stopRecording();
          });
        } finally { state.recordingPending = false; }
        state.recording = true; render();
      } else await stopRecording();
    }
    else if (action === 'analyze-speech' && state.audioBase64) {
      await runWorkflow('speaking', { activityId: state.data.activity.id, audioBase64: state.audioBase64 }); state.audioBase64 = null;
    }
  } catch (error) { toast(error.message); }
});

async function stopRecording() {
  state.recording = false;
  try {
    const audio = await recorder.stop();
    if (state.recordMode === 'tool') { state.toolAudioBase64 = audio; toast('Recording ready. Submit it to recognize or translate your speech.'); }
    else { state.audioBase64 = audio; toast('Recording ready. Select “Analyze my speaking” for feedback.'); }
  }
  catch (error) { state.audioBase64 = null; state.toolAudioBase64 = null; toast(error.message); }
  render();
}

document.addEventListener('submit', async event => {
  const form = event.target;
  if (!['auth-form', 'settings-form', 'chat-form', 'generate-form', 'activity-form'].includes(form.id)) return;
  event.preventDefault();
  const fields = Object.fromEntries(new FormData(form));
  if (['auth-form', 'settings-form'].includes(form.id)) {
    if (state.busy) return;
    const submit = form.querySelector('[type="submit"]'); submit.disabled = true;
    const formError = form.querySelector('#form-error'); formError.textContent = '';
    try {
      if (fields.dailyMinutes) fields.dailyMinutes = Number(fields.dailyMinutes);
      const endpoint = form.id === 'settings-form' ? '/api/profile' : `/api/auth/${form.dataset.mode}`;
      await api(endpoint, fields); await refresh();
      state.result = null; state.completedActivityId = null; state.audioBase64 = null; modal.close(); navigate('dashboard');
      toast(form.id === 'settings-form' ? 'Your learning preferences are saved.' : 'Your learning space is ready.');
    } catch (error) { formError.textContent = error.message; submit.disabled = false; }
    return;
  }
  if (form.id === 'chat-form') { state.draft = fields.message; await runWorkflow('conversation', { message: fields.message, durationSeconds: elapsed() }); }
  if (form.id === 'generate-form') await generate(state.practiceKind, fields.focus);
  if (form.id === 'activity-form') {
    const activity = state.data.activity;
    if (!activity) return;
    state.activityAnswers = activity.content.questions.map((_, i) => Number(fields[`q${i}`]));
    state.writingDraft = fields.text || '';
    await runWorkflow('assessActivity', { activityId: activity.id, answers: state.activityAnswers, text: state.writingDraft, durationSeconds: elapsed() });
  }
});
document.addEventListener('input', event => {
  if (event.target.name === 'message') state.draft = event.target.value;
  if (event.target.id === 'word-search') {
    const query = event.target.value.toLowerCase();
    document.querySelectorAll('[data-word-search]').forEach(row => { row.hidden = !row.dataset.wordSearch.includes(query); });
  }
  if (event.target.id === 'universal-search') updateSearch(event.target.value);
  if (event.target.id === 'transcript-editor') { const result = currentToolResult(); if (result) result.text = event.target.value; }
  if (event.target.closest('#language-tool-form')) state.toolDraft = toolFormFields(event.target.closest('form'));
});
document.addEventListener('keydown',event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') { event.preventDefault(); showSearch(); }
});
document.addEventListener('change',async event => {
  try {
    if (event.target.id === 'language') {
      const accent = document.querySelector('#accent'); const variants = languageMap[event.target.value]?.variants || [];
      if (accent) accent.innerHTML = variants.map(locale => `<option>${e(locale)}</option>`).join('');
    }
    if (event.target.id === 'tool-source' || event.target.id === 'tool-target') {
      state.toolDraft = toolFormFields(document.querySelector('#language-tool-form'));
      if (state.selectedTool === 'transliterate') { state.toolDraft.fromScript = languageMap[state.toolDraft.sourceLanguage]?.scripts[0]; state.toolDraft.toScript = 'Latn'; }
      state.toolConversationId = null; state.toolResult = null; render();
    }
    if (event.target.id === 'tool-file') {
      const file = event.target.files[0]; if (!file) return;
      if (file.size > 8_000_000) throw new Error('Choose a file up to 8 MB.');
      const form = document.querySelector('#language-tool-form'); state.toolDraft = toolFormFields(form); state.uploadPending = true;
      const bytes = new Uint8Array(await file.arrayBuffer()); let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i,i+8192));
      const fileBase64 = btoa(binary); const mime = /\.png$/i.test(file.name) ? 'image/png' : /\.jpe?g$/i.test(file.name) ? 'image/jpeg' : null;
      state.toolUpload = { filename:file.name,fileBase64,preview:mime ? `data:${mime};base64,${fileBase64}` : null }; state.uploadPending = false; render();
    }
  } catch (error) { state.uploadPending = false; toast(error.message); }
});
document.addEventListener('submit',async event => {
  const form = event.target;
  if (!['language-tool-form','add-language-form','translation-preferences-form'].includes(form.id)) return;
  event.preventDefault();
  if (state.busy || state.uploadPending || state.recording || state.recordingPending) return;
  if (form.id === 'language-tool-form') {
    try {
      const fields = toolFormFields(form); const tool = form.dataset.tool; state.toolDraft = fields;
      if (tool === 'tts') { if (!fields.text?.trim()) throw new Error('Type a phrase to hear it spoken.'); speak(fields.text,fields.targetLanguage); return; }
      const definition = toolCatalog.find(item => item.id === tool);
      if (!authorizeTool(tool,state.toolUpload?.filename)) return;
      if (['image','document'].includes(definition.input) && !state.toolUpload) throw new Error('Choose or capture a file first.');
      if (definition.input === 'audio' && !state.toolAudioBase64) throw new Error('Record a phrase first.');
      if (definition.input === 'turn' && !fields.text?.trim() && !state.toolAudioBase64) throw new Error('Type or record a conversation turn.');
      const payload = { ...fields,tool,...(state.toolUpload ? { filename:state.toolUpload.filename,fileBase64:state.toolUpload.fileBase64 } : {}),
        ...(state.toolAudioBase64 ? { audioBase64:state.toolAudioBase64 } : {}),durationSeconds:elapsed() };
      if (tool === 'live-conversation') {
        payload.conversationId = state.toolConversationId;
        if (fields.speaker === 'B') { payload.sourceLanguage = fields.targetLanguage; payload.targetLanguage = fields.sourceLanguage; }
      }
      closeCamera();
      const result = await runWorkflow('tool',payload);
      if (result) { state.toolAudioBase64 = null; render(); }
    } catch (error) { toast(error.message); }
    return;
  }
  if (state.demo) { showAuth(); return; }
  const submit = form.querySelector('[type=submit]'); submit.disabled = true;
  try {
    const fields = Object.fromEntries(new FormData(form));
    if (form.id === 'add-language-form') {
      fields.dailyMinutes = Number(fields.dailyMinutes); await api('/api/profiles',fields);
      if (form.elements.activate.checked) { await api('/api/profiles/select',{ language:fields.language }); state.result = null; }
    } else {
      fields.learnFromTools = form.elements.learnFromTools.checked; await api('/api/preferences',fields);
      localStorage.setItem('lingua-theme',fields.theme); state.toolDraft = null;
    }
    await refresh(); modal.close(); render(); toast('Your preferences are saved.');
  } catch (error) { form.querySelector('#form-error').textContent = error.message; submit.disabled = false; }
});
modal.addEventListener('click', event => { if (event.target === modal && (event.clientX < modal.getBoundingClientRect().left || event.clientX > modal.getBoundingClientRect().right || event.clientY < modal.getBoundingClientRect().top || event.clientY > modal.getBoundingClientRect().bottom)) modal.close(); });
window.addEventListener('beforeunload', event => { if (state.recording || state.recordingPending || state.busy || state.cameraActive) { event.preventDefault(); event.returnValue = ''; } });

try {
  state.status = await api('/api/status');
  await refresh();
  if (state.data.activity) state.practiceKind = state.data.activity.kind;
  render();
} catch (error) { state.error = error.message; render(); }
