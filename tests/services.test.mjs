import test from 'node:test';
import assert from 'node:assert/strict';
import { AIService, OpenAICompatibleProvider, AnthropicProvider } from '../server/ai/providers.mjs';
import { SpeechService, validateWav } from '../server/ai/speech.mjs';
import { scheduleReview } from '../server/learning/spaced-repetition.mjs';
import { agents } from '../server/agents/definitions.mjs';
import { wav, outputFor } from './fixtures.mjs';

test('unconfigured AI does not generate simulated results', async () => {
  const ai = new AIService({ provider: 'disabled' });
  assert.equal(ai.status().configured, false);
  await assert.rejects(ai.generate({ ...agents.tutor, context: {}, task: {}, dependencies: {} }), { code: 'AI_NOT_CONFIGURED' });
});

test('OpenAI-compatible adapter sends credentials server-side and uses structured JSON', async () => {
  const provider = new OpenAICompatibleProvider({ apiKey: 'secret-test', model: 'model-test', baseUrl: 'https://example.com/v1' }, async (url, options) => {
    assert.equal(url, 'https://example.com/v1/chat/completions');
    assert.equal(options.headers.Authorization, 'Bearer secret-test');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'model-test'); assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.max_tokens, 8000);
    return new Response(JSON.stringify({ choices: [{ message: { content: '{"reply":"hello"}' } }] }));
  });
  assert.equal(await provider.complete({ system: 'system', prompt: 'prompt', schema: agents.tutor.schema }), '{"reply":"hello"}');
});

test('Anthropic adapter requires the structured response tool', async () => {
  const provider = new AnthropicProvider({ apiKey: 'secret-test', model: 'model-test', baseUrl: 'https://api.anthropic.com/v1' }, async (url, options) => {
    const body = JSON.parse(options.body);
    assert.equal(body.tool_choice.name, 'learning_result');
    assert.equal(body.max_tokens, 8000);
    assert.deepEqual(body.tools[0].input_schema, agents.tutor.schema);
    return new Response(JSON.stringify({ content: [{ type: 'tool_use', name: 'learning_result', input: outputFor('tutor') }] }));
  });
  assert.equal((await provider.complete({ system: 'system', prompt: 'prompt', schema: agents.tutor.schema })).reply, outputFor('tutor').reply);
});

test('configured output budgets reach both providers using the model-compatible token parameter', async () => {
  for (const [provider, tokenParameter] of [['openai-compatible', 'max_tokens'], ['openai-compatible', 'max_completion_tokens'], ['anthropic', 'max_tokens']]) {
    let requests = 0;
    const ai = new AIService({ provider, tokenParameter, model:'test-model', apiKey:'test-only', baseUrl:'https://example.com/v1', maxOutputTokens:4096 }, {
      fetchImpl:async (_, request) => {
        requests++;
        const body = JSON.parse(request.body);
        assert.equal(body[tokenParameter],4096);
        assert.equal(Object.hasOwn(body,tokenParameter === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens'),false);
        return new Response(JSON.stringify(provider === 'anthropic'
          ? {content:[{type:'tool_use',name:'learning_result',input:outputFor('tutor')}]}
          : {choices:[{message:{content:JSON.stringify(outputFor('tutor'))}}]}));
      },
    });
    const result = await ai.generate({...agents.tutor,context:{},task:{},dependencies:{}});
    assert.equal(result.reply,outputFor('tutor').reply);
    assert.equal(requests,1);
  }
});

test('AI timeouts and upstream errors do not expose provider secrets', async () => {
  const ai = new AIService({ provider: 'openai-compatible', model: 'model', apiKey: 'secret-test', baseUrl: 'https://example.com/v1', timeoutMs: 20 }, {
    fetchImpl: async (_, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('secret-test')), { once: true });
      setTimeout(resolve, 100); // Keep the event loop alive for the AbortSignal timeout.
    }),
  });
  await assert.rejects(ai.generate({ ...agents.tutor, context: {}, task: {}, dependencies: {} }), error => error.code === 'AI_TIMEOUT' && !error.message.includes('secret-test'));
  const provider = new OpenAICompatibleProvider({ baseUrl: 'https://example.com' }, async () => new Response('secret-test', { status: 429 }));
  await assert.rejects(provider.complete({}), error => error.code === 'AI_RATE_LIMITED' && !error.message.includes('secret-test'));
});

test('WAV validation rejects wrong format, truncated recordings, and short input', () => {
  assert.equal(validateWav(wav(2)).durationSeconds, 2);
  assert.throws(() => validateWav(Buffer.from('fake')), { code: 'INVALID_AUDIO' });
  assert.throws(() => validateWav(wav().subarray(0, 100)), { code: 'INVALID_AUDIO' });
  const stereo = wav(); stereo.writeUInt16LE(2, 22);
  assert.throws(() => validateWav(stereo), { code: 'INVALID_AUDIO' });
  assert.throws(() => validateWav(wav(0)), { code: 'INVALID_AUDIO' });
});

test('transcription never claims pronunciation measurement', async () => {
  const service = new SpeechService({ provider: 'openai-compatible', apiKey: 'test', model: 'whisper-1', baseUrl: 'https://example.com/v1' }, async (url, options) => {
    assert.equal(url, 'https://example.com/v1/audio/transcriptions');
    assert.equal(options.body.get('language'), 'es');
    return new Response(JSON.stringify({ text: 'Hola.' }));
  });
  const result = await service.analyze({ audio: wav(), locale: 'es-ES', referenceText: 'Hola.' });
  assert.equal(result.pronunciation, null); assert.match(result.limitation, /not measured/);
});

test('Azure speech uses actual valid audio metrics and rejects missing or invalid scores', async () => {
  const settings = { provider: 'azure', apiKey: 'test', region: 'centralindia' };
  const service = new SpeechService(settings, async (url, options) => {
    assert.match(url, /centralindia\.stt\.speech/);
    const header = JSON.parse(Buffer.from(options.headers['Pronunciation-Assessment'], 'base64').toString());
    assert.equal(header.ReferenceText, 'Hola.');
    return new Response(JSON.stringify({ RecognitionStatus: 'Success', NBest: [{ Display: 'Hola.', AccuracyScore: 92, FluencyScore: 81, CompletenessScore: 100, PronScore: 89, Words: [{ Word: 'Hola', AccuracyScore: 92, ErrorType: 'None' }] }] }));
  });
  assert.equal((await service.analyze({ audio: wav(), locale: 'es-ES', referenceText: 'Hola.' })).pronunciation.fluency, 81);
  service.fetch = async () => new Response(JSON.stringify({ RecognitionStatus: 'Success', NBest: [{ Display: 'Hola.', AccuracyScore: 900 }] }));
  await assert.rejects(service.analyze({ audio: wav(), locale: 'es-ES', referenceText: 'Hola.' }), { code: 'INVALID_SPEECH_OUTPUT' });
});

test('spaced repetition brings failed recall back soon and lengthens successful recall', () => {
  const word = { id: 'word', ease: 2.5, repetitions: 3, interval_days: 6 };
  const again = scheduleReview(word, 'again', 0);
  assert.equal(again.repetitions, 0); assert.equal(Date.parse(again.dueAt), 600000);
  assert.ok(scheduleReview(word, 'easy', 0).intervalDays > scheduleReview(word, 'good', 0).intervalDays);
  assert.throws(() => scheduleReview(word, 'made-up'), { code: 'INVALID_RATING' });
});
