import test from 'node:test';
import assert from 'node:assert/strict';
import { setup,profile,wav,outputFor } from './fixtures.mjs';
import { toolInput } from '../server/tools/input.mjs';
import { toolCatalog } from '../public/catalog.js';
import { languageCatalog } from '../public/languages.js';
import { SpeechService } from '../server/ai/speech.mjs';

const png = Buffer.from([137,80,78,71,13,10,26,10,0,0,0,0]);
function withServices(options = {}) {
  const env = setup(options);
  env.speech.status = () => ({configured:true});
  env.speech.transcribe = async ({locale}) => ({transcript:'ನಮಸ್ಕಾರ',durationSeconds:2,pronunciation:null,source:'test-speech',limitation:'No pronunciation measured.'});
  env.orchestrator.services.ocr.status = () => ({configured:true});
  env.orchestrator.services.ocr.extract = async () => ({text:'Hello from a document.',source:'test-ocr',pages:1});
  return env;
}
function requestFor(id) {
  const request = {text:'ನಮಸ್ಕಾರ',sourceLanguage:'Kannada',targetLanguage:'English',learn:false};
  if (['voice-translate','stt'].includes(id)) request.audioBase64 = wav().toString('base64');
  if (['camera-translate','image-translate'].includes(id)) { request.fileBase64 = png.toString('base64');request.filename = 'sample.png'; }
  if (id === 'documents') { request.fileBase64 = Buffer.from('A short document.').toString('base64');request.filename = 'sample.txt'; }
  if (id === 'transliterate') {request.fromScript = 'Knda';request.toScript = 'Latn';}
  if (id === 'live-conversation') request.speaker = 'A';
  return request;
}

for (const tool of toolCatalog.filter(tool => tool.id !== 'tts')) {
  test(`${tool.name} executes its real workflow contract and saves only successful results`,async t => {
    const env = withServices();t.after(() => env.repository.close());
    const input = toolInput(tool.id,requestFor(tool.id),profile);
    const result = await env.orchestrator.execute(env.user.id,'tool',input);
    assert.ok(result.toolResult.text);
    assert.equal(env.repository.toolHistory(env.user.id)[0].tool,tool.id);
    assert.equal(env.repository.runs(env.user.id)[0].status,'completed');
    assert.equal(env.repository.stats(env.user.id,'English').sessions,0);
    const persisted = env.repository.db.prepare('SELECT input FROM tool_history WHERE user_id = ?').get(env.user.id);
    assert.equal(JSON.parse(persisted.input).file,undefined);assert.equal(JSON.parse(persisted.input).audio,undefined);
    for (const output of Object.values(result.outputs)) assert.equal(output.memory,undefined);
  });
}

test('Kannada speech becomes English learning material through a coordinated workflow',async t => {
  const env = withServices();t.after(() => env.repository.close());
  env.repository.updateProfile(env.user.id,{...profile,language:'Kannada',nativeLanguage:'Kannada'});
  let observedLocale;
  env.speech.transcribe = async ({audio,locale}) => {observedLocale = locale;assert.ok(Buffer.isBuffer(audio));return {transcript:'ನಮಸ್ಕಾರ',durationSeconds:2,pronunciation:null,source:'test-speech',limitation:'No pronunciation was measured.'};};
  const result = await env.orchestrator.execute(env.user.id,'tool',toolInput('voice-translate',{...requestFor('voice-translate'),learn:true},profile));
  assert.equal(observedLocale,'kn-IN');assert.equal(result.toolResult.transcript,'ನಮಸ್ಕಾರ');
  assert.equal(result.toolResult.text,'Hello, how are you?');
  assert.equal(result.language,'English');assert.equal(result.activity.kind,'quiz');
  assert.equal(result.activity.content.questions[0].answerIndex,undefined);
  const names = env.repository.runs(env.user.id)[0].steps.map(step => step.agent);
  for (const name of ['speechService','translation','voice','culture','pronunciation','grammar','vocabulary','content','learningPath','progress']) assert.ok(names.includes(name),name);
  assert.equal(names.includes('translationService'),false,'LLM mode must not pretend an external translator ran');
  const translationCall = env.provider.calls.find(call => call.id === 'translation');
  assert.equal(translationCall.learnerContext.profile.language,'English');
  assert.equal(translationCall.learnerContext.profile.nativeLanguage,'Kannada');
  assert.equal(translationCall.task.text,'ನಮಸ್ಕಾರ');
  assert.equal(env.repository.profiles(env.user.id).some(profile => profile.language === 'English'),true);
  assert.equal(env.repository.toolHistory(env.user.id)[0].result.practiceActivityId,result.activity.id);
  assert.ok(env.repository.vocabulary(env.user.id,'English').length);
  assert.equal(env.repository.profile(env.user.id).language,'Kannada','tool should not switch active learning language');
});

test('failed learning collaboration does not enroll a language, save words, or publish a translation',async t => {
  const env = withServices({fail:'content'});t.after(() => env.repository.close());
  await assert.rejects(env.orchestrator.execute(env.user.id,'tool',toolInput('translate',{...requestFor('translate'),learn:true},profile)),{code:'INVALID_AI_OUTPUT'});
  assert.equal(env.repository.toolHistory(env.user.id).length,0);
  assert.equal(env.repository.vocabulary(env.user.id,'English').length,0);
  assert.equal(env.repository.profiles(env.user.id).some(profile => profile.language === 'English'),false);
  assert.equal(env.repository.runs(env.user.id)[0].status,'failed');
});

test('long text translations preserve every section and share preceding translation context',async t => {
  const env = setup();t.after(() => env.repository.close());
  const text = 'A paragraph with enough text to need several translation sections. '.repeat(85).trim();
  const translationCalls = [];
  const complete = env.provider.complete.bind(env.provider);
  env.provider.complete = async args => {
    const payload = JSON.parse(args.prompt.split('\nYour previous response')[0]);
    if (!args.system.startsWith('You are the Translation Agent of')) return complete(args);
    translationCalls.push(payload);
    // Echo source sections only in this test to reveal any dropped source text.
    return JSON.stringify({...outputFor('translation'),translatedText:payload.task.text});
  };
  const result = await env.orchestrator.execute(env.user.id,'tool',toolInput('translate',{
    text,sourceLanguage:'English',targetLanguage:'Spanish',learn:false,
  },profile));
  assert.ok(translationCalls.length > 1);
  assert.equal(translationCalls.map(call => call.task.text).join(''),text);
  for (const [index,call] of translationCalls.entries()) {
    assert.ok(call.task.text.length <= 2500);
    assert.equal(call.task.section,index + 1);
    assert.equal(call.task.sections,translationCalls.length);
    assert.equal(call.otherAgentResults.previousSection,index ? translationCalls[index - 1].task.text : undefined);
  }
  assert.equal(result.toolResult.text,translationCalls.map(call => call.task.text).join('\n'));
  assert.equal(env.repository.toolHistory(env.user.id)[0].result.text,result.toolResult.text);
  assert.equal(env.repository.runs(env.user.id)[0].steps.filter(step => step.agent === 'translation').length,translationCalls.length);
});

test('two-person conversation preserves actual turns and denies another user access',async t => {
  const env = withServices();t.after(() => env.repository.close());
  const first = await env.orchestrator.execute(env.user.id,'tool',toolInput('live-conversation',requestFor('live-conversation'),profile));
  const second = await env.orchestrator.execute(env.user.id,'tool',toolInput('live-conversation',{text:'Hello!',sourceLanguage:'English',targetLanguage:'Kannada',speaker:'B',conversationId:first.toolResult.conversationId},profile));
  assert.equal(second.toolResult.turns.length,2);assert.equal(second.toolResult.turns[1].speaker,'B');
  const lastCall = env.provider.calls.filter(call => call.id === 'voice').at(-1);
  assert.equal(lastCall.task.previousTurns.length,1);
  const other = env.repository.createUser({email:'other-tools@example.com',name:'Other',passwordHash:'00'.repeat(64),passwordSalt:'test',profile});
  const before = env.provider.calls.length;
  await assert.rejects(env.orchestrator.execute(other.id,'tool',toolInput('live-conversation',{...requestFor('live-conversation'),conversationId:first.toolResult.conversationId},profile)),{code:'CONVERSATION_NOT_FOUND'});
  assert.equal(env.provider.calls.length,before);
});

test('multiple profiles preserve level, goals, locale, teaching style and progress independently',t => {
  const env = setup();t.after(() => env.repository.close());
  env.repository.addProfile(env.user.id,{...profile,language:'Kannada',level:'A1',goal:'Kannada conversations',teachingStyle:'socratic',dialect:'Bengaluru usage',accent:'kn-IN'});
  env.repository.selectProfile(env.user.id,'Kannada');
  assert.equal(env.repository.profile(env.user.id).teachingStyle,'socratic');
  assert.equal(env.repository.profile(env.user.id).dialect,'Bengaluru usage');
  env.repository.selectProfile(env.user.id,'Spanish');assert.equal(env.repository.profile(env.user.id).level,'A2');
  assert.equal(env.repository.profile(env.user.id).goal,profile.goal);
  env.repository.updatePreferences(env.user.id,{theme:'dark',translationTarget:'Kannada'});
  assert.equal(env.repository.preferences(env.user.id).theme,'dark');
});

test('catalog includes requested Indian languages; unsupported inputs fail before provider calls',() => {
  const names = languageCatalog.map(item => item.name);
  for (const language of ['Kannada','Hindi','Tamil','Telugu','Malayalam','Bengali','Marathi','Gujarati','Punjabi','Assamese','Odia']) assert.ok(names.includes(language));
  assert.ok(names.length >= 90);assert.equal(new Set(names).size,names.length);
  assert.throws(() => toolInput('translate',{...requestFor('translate'),targetLanguage:'Unknown language'},profile),{code:'LANGUAGE_UNSUPPORTED'});
  assert.throws(() => toolInput('transliterate',{...requestFor('transliterate'),toScript:'Hebr'},profile),{code:'SCRIPT_UNSUPPORTED'});
  assert.throws(() => toolInput('image-translate',{fileBase64:Buffer.from('not an image').toString('base64'),filename:'fake.png'},profile),{code:'INVALID_IMAGE'});
});

test('Azure voice transcription for Kannada does not claim pronunciation or require a reference',async () => {
  const service = new SpeechService({provider:'azure',region:'centralindia',apiKey:'test'},async (url,request) => {
    assert.match(url,/language=kn-IN/);assert.equal(request.headers['Pronunciation-Assessment'],undefined);
    return new Response(JSON.stringify({RecognitionStatus:'Success',NBest:[{Display:'ನಮಸ್ಕಾರ'}]}));
  });
  const result = await service.transcribe({audio:wav(),locale:'kn-IN'});
  assert.equal(result.transcript,'ನಮಸ್ಕಾರ');assert.equal(result.pronunciation,null);
  await assert.rejects(service.analyze({audio:wav(),locale:'kn-IN',referenceText:'ನಮಸ್ಕಾರ'}),{code:'PRONUNCIATION_LANGUAGE_UNSUPPORTED'});
});
