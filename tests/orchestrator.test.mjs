import test from 'node:test';
import assert from 'node:assert/strict';
import { setup, profile, wav } from './fixtures.mjs';

test('conversation coordinates six agents, shares dependencies, and commits learner context', async t => {
  const env = setup(); t.after(() => env.repository.close());
  const result = await env.orchestrator.execute(env.user.id, 'conversation', { message: 'Yo tener café', durationSeconds: 90 });
  assert.deepEqual(env.provider.calls.map(call => call.id).sort(), ['assessment', 'grammar', 'learningPath', 'progress', 'tutor', 'vocabulary']);
  const assessmentCall = env.provider.calls.find(call => call.id === 'assessment');
  assert.equal(assessmentCall.otherAgentResults.grammar.corrections[0].topic, 'Present tense');
  assert.match(env.provider.calls.find(call => call.id === 'progress').otherAgentResults.learningPath.title, /Travel/);
  assert.equal(result.outputs.tutor.reply, '¡Hola! ¿Quieres un café?');
  assert.equal(result.outputs.tutor.memory, undefined);
  assert.equal(result.outputs.grammar.exercises[0].answerIndex, undefined);
  assert.equal(env.repository.conversation(env.user.id, 'Spanish').length, 2);
  assert.equal(env.repository.vocabulary(env.user.id, 'Spanish').length, 1);
  assert.equal(env.repository.stats(env.user.id, 'Spanish').weeklyMinutes, 2);
  assert.equal(env.repository.runs(env.user.id, 'Spanish')[0].status, 'completed');
  assert.equal(env.repository.context(env.user.id, 'Spanish', 'tutor').agentMemory.length, 1);
  assert.equal(env.repository.insights(env.user.id, 'Spanish').recommendation.kind, 'quiz');
  await env.orchestrator.execute(env.user.id, 'conversation', { message: '¿Cuánto cuesta?' });
  const nextTutor = env.provider.calls.filter(call => call.id === 'tutor').at(-1);
  assert.equal(nextTutor.learnerContext.conversation.length, 2);
  assert.equal(nextTutor.learnerContext.recentPerformance.length, 1);
  assert.equal(nextTutor.learnerContext.agentMemory.length, 1);
  assert.equal(nextTutor.learnerContext.profile.goal, profile.goal);
});

test('invalid AI output fails the run without updating vocabulary, plan, messages or memory', async t => {
  const env = setup({ fail: 'learningPath' }); t.after(() => env.repository.close());
  await assert.rejects(env.orchestrator.execute(env.user.id, 'conversation', { message: 'Yo tener café' }), { code: 'INVALID_AI_OUTPUT' });
  assert.equal(env.repository.conversation(env.user.id, 'Spanish').length, 0);
  assert.equal(env.repository.vocabulary(env.user.id, 'Spanish').length, 0);
  assert.equal(env.repository.attempts(env.user.id, 'Spanish').length, 0);
  assert.equal(env.repository.plan(env.user.id, 'Spanish'), null);
  assert.deepEqual(env.repository.context(env.user.id, 'Spanish', 'tutor').agentMemory, []);
  const run = env.repository.runs(env.user.id, 'Spanish')[0];
  assert.equal(run.status, 'failed');
  assert.equal(run.steps.find(step => step.agent === 'learningPath').status, 'failed');
  assert.equal(env.provider.calls.filter(call => call.id === 'learningPath').length, 2);
  assert.equal(env.provider.calls.some(call => call.id === 'progress'), false);
});

test('quiz answer keys stay server-side and objective scoring ignores client scores', async t => {
  const env = setup(); t.after(() => env.repository.close());
  const generated = await env.orchestrator.execute(env.user.id, 'createActivity', { kind: 'quiz' });
  assert.equal(generated.activity.content.questions[0].answerIndex, undefined);
  assert.equal(env.repository.stats(env.user.id, 'Spanish').sessions, 0);
  assert.equal(env.repository.activity(env.user.id, 'Spanish', generated.activity.id).content.questions[0].answerIndex, 0);
  const result = await env.orchestrator.execute(env.user.id, 'assessActivity', { activityId: generated.activity.id, answers: [0, 1, 2], score: 100, durationSeconds: 180 });
  assert.equal(result.score, 33);
  assert.equal(result.objectiveResults.filter(item => item.correct).length, 1);
  assert.equal(env.repository.attempts(env.user.id, 'Spanish')[0].score, 33);
  assert.ok(env.repository.activity(env.user.id, 'Spanish', generated.activity.id).completedAt);
  const before = env.provider.calls.length;
  await assert.rejects(env.orchestrator.execute(env.user.id, 'assessActivity', { activityId: generated.activity.id, answers: [0, 0, 0] }), { code: 'ALREADY_COMPLETED' });
  assert.equal(env.provider.calls.length, before);
});

test('learner records are isolated by user and target language before billable calls', async t => {
  const env = setup(); t.after(() => env.repository.close());
  const generated = await env.orchestrator.execute(env.user.id, 'createActivity', { kind: 'quiz' });
  const other = env.repository.createUser({ email: 'other@example.com', name: 'Other', passwordHash: '00'.repeat(64), passwordSalt: 'test', profile: { ...profile, level: 'C1' } });
  const calls = env.provider.calls.length;
  await assert.rejects(env.orchestrator.execute(other.id, 'assessActivity', { activityId: generated.activity.id, answers: [0, 0, 0] }), { code: 'ACTIVITY_NOT_FOUND' });
  assert.equal(env.provider.calls.length, calls);
  assert.equal(env.repository.vocabulary(other.id, 'Spanish').length, 0);
  env.repository.updateProfile(env.user.id, { ...profile, language: 'French' });
  assert.equal(env.repository.context(env.user.id, 'French', 'tutor').learningPlan, null);
  assert.equal(env.repository.context(env.user.id, 'French', 'tutor').vocabulary.length, 0);
  assert.equal(env.repository.context(env.user.id, 'French', 'tutor').recentPerformance.length, 0);
  await assert.rejects(env.orchestrator.execute(env.user.id, 'assessActivity', { activityId: generated.activity.id, answers: [0, 0, 0] }), { code: 'ACTIVITY_NOT_FOUND' });
  env.repository.updateProfile(env.user.id, profile);
  assert.ok(env.repository.plan(env.user.id, 'Spanish'));
});

test('a vocabulary review schedules recall and remains unscored as proficiency', async t => {
  const env = setup(); t.after(() => env.repository.close());
  await env.orchestrator.execute(env.user.id, 'conversation', { message: 'Yo tener café' });
  const word = env.repository.vocabulary(env.user.id, 'Spanish')[0];
  const result = await env.orchestrator.execute(env.user.id, 'review', { wordId: word.id, rating: 'good' });
  assert.ok(Date.parse(result.nextReviewAt) > Date.now());
  assert.equal(env.repository.vocabulary(env.user.id, 'Spanish')[0].repetitions, 1);
  assert.equal(env.repository.attempts(env.user.id, 'Spanish')[0].score, null);
  await assert.rejects(env.orchestrator.execute(env.user.id, 'review', { wordId: word.id, rating: 'good' }), { code: 'REVIEW_NOT_DUE' });
});

test('overlapping workflows are rejected without changing preferences mid-run', async t => {
  let release; let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  const env = setup({ block: async id => { if (id === 'learningPath') { entered(); await gate; } } });
  t.after(() => env.repository.close());
  const first = env.orchestrator.execute(env.user.id, 'plan', {});
  await ready;
  await assert.rejects(env.orchestrator.execute(env.user.id, 'plan', {}), { code: 'WORKFLOW_BUSY' });
  assert.throws(() => env.repository.updateProfile(env.user.id, { ...profile, language: 'French' }), { code: 'WORKFLOW_BUSY' });
  release(); await first;
  assert.equal(env.repository.runs(env.user.id, 'Spanish')[0].status, 'completed');
});

test('speaking workflow uses real supplied service evidence and does not store audio', async t => {
  const env = setup(); t.after(() => env.repository.close());
  env.speech.status = () => ({ configured: true });
  env.speech.analyze = async ({ audio, locale, referenceText }) => {
    assert.equal(locale, 'es-ES'); assert.ok(referenceText); assert.ok(Buffer.isBuffer(audio));
    return { transcript: 'Me gustaría un café.', durationSeconds: 2, pronunciation: null, source: 'transcription', limitation: 'Pronunciation was not measured.' };
  };
  const generated = await env.orchestrator.execute(env.user.id, 'createActivity', { kind: 'speaking' });
  const result = await env.orchestrator.execute(env.user.id, 'speaking', { activityId: generated.activity.id, audio: wav() });
  assert.equal(result.speechEvidence.pronunciation, null);
  assert.equal(env.provider.calls.find(call => call.id === 'speaking').task.speechEvidence.source, 'transcription');
  const saved = env.repository.db.prepare('SELECT input FROM attempts WHERE user_id = ? ORDER BY rowid DESC LIMIT 1').get(env.user.id);
  assert.equal(JSON.parse(saved.input).audio, undefined);
  assert.equal(env.repository.runs(env.user.id, 'Spanish')[0].steps[0].agent, 'speechService');
});

test('cultural lessons and writing assessments delegate to their specialists',async t => {
  const env = setup();t.after(() => env.repository.close());
  await env.orchestrator.execute(env.user.id,'createActivity',{kind:'reading',focus:'Cultural idioms and regional expressions'});
  assert.ok(env.provider.calls.some(call => call.id === 'culture'));
  const writing = await env.orchestrator.execute(env.user.id,'createActivity',{kind:'writing'});
  const feedback = await env.orchestrator.execute(env.user.id,'assessActivity',{activityId:writing.activity.id,text:'A short written response.'});
  assert.ok(feedback.outputs.writing.revisedText);
  assert.equal(env.repository.runs(env.user.id,'Spanish')[0].steps.some(step => step.agent === 'writing'),true);
});
