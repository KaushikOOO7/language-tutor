// Canned outputs are restricted to automated tests. Production has no fake AI provider.
import { Repository } from '../server/database.mjs';
import { AIService } from '../server/ai/providers.mjs';
import { SpeechService } from '../server/ai/speech.mjs';
import { AgentOrchestrator } from '../server/agents/orchestrator.mjs';
import { agents } from '../server/agents/definitions.mjs';

export const profile = { language: 'Spanish', nativeLanguage: 'English', level: 'A2', goal: 'Travel and conversation', dailyMinutes: 20 };
const memory = ['Learner is practicing everyday travel conversations.'];
const question = { prompt: 'What does café mean?', options: ['coffee', 'water', 'bread'], answerIndex: 0, explanation: 'Café means coffee.' };
export function outputFor(id, task = {}) {
  return structuredClone({
    translation:{ translatedText:task.operation === 'transliterate' ? 'namaskara' : 'Hello, how are you?',explanation:'A greeting in the requested language.',detectedLanguage:'Kannada',confidence:0.9,
      definitions:[{partOfSpeech:'noun',definition:'A word used in a greeting.',example:'Hello, how are you?'}],synonyms:['greeting'],antonyms:[],notes:['Test provider response.'],memory },
    voice:{explanation:'The supplied phrase is a greeting.',suggestedReply:'Hello!',clarification:'Ask politely if you need clarification.',memory},
    pronunciation:{phonetic:'/həˈləʊ/',syllables:['hel','lo'],guidance:'Practice the greeting slowly.',practicePhrase:'Hello, how are you?',cautions:['Phonetic guidance is an estimate, not an audio measurement.'],memory},
    writing:{revisedText:'A clear, natural test sentence.',explanation:'The writing is clearer.',changes:['Improved sentence clarity.'],alternatives:['A natural alternative.'],memory},
    document:{translatedText:'Translated document section.',summary:'A short document section.',glossary:[{source:'hello',target:'greeting'}],warnings:[],memory},
    culture:{explanation:'A polite everyday greeting.',expressions:[],notes:[],memory},
    tutor: { reply: '¡Hola! ¿Quieres un café?', nextPrompt: 'What would you like to order?', memory },
    speaking: { feedback: 'The transcript contains a useful ordering phrase. Pronunciation is only measured if audio scores are supplied.', strengths: ['A clear ordering phrase'], improvements: ['Add a polite question'], exercises: ['Practice: ¿Me puedes traer un café?'], memory },
    grammar: { explanation: 'Use tengo with yo.', corrections: [{ original: 'Yo tener café', corrected: 'Yo tengo café', explanation: 'Conjugate tener for yo.', topic: 'Present tense' }], exercises: [question], memory },
    vocabulary: { words: [{ term: 'café', translation: 'coffee', example: 'Quiero un café.', tags: ['food'] }], advice: 'Use café in your next conversation.', memory },
    learningPath: { title: 'Travel conversations', rationale: 'Practice ordering and asking questions.', focus: ['Ordering', 'Present tense'], activities: [
      { title: 'Order a coffee', kind: 'conversation', durationMinutes: 10, objective: 'Use a polite request.' },
      { title: 'Review useful words', kind: 'vocabulary', durationMinutes: 5, objective: 'Recall café.' },
      { title: 'Read a menu', kind: 'reading', durationMinutes: 10, objective: 'Find useful phrases.' },
    ], memory },
    assessment: { feedback: 'A short practice response, with a conjugation to work on.', estimatedLevel: 'A2', score: 75, strengths: ['Useful vocabulary'], weaknesses: ['Conjugation'], topics: [{ topic: 'Present tense', mastery: 60 }], memory },
    progress: { summary: 'This activity adds evidence about present-tense practice.', insights: ['Practice present-tense requests.'], recommendation: { kind: 'quiz', title: 'Present tense practice', reason: 'Practice the pattern from this response.' }, memory },
    content: { title: 'At the café', kind: task.kind || 'lesson', instructions: 'Read and answer the questions.', text: 'Me gustaría un café, por favor.', referenceText: 'Me gustaría un café, por favor.', listeningText: 'Me gustaría un café, por favor.', writingPrompt: 'Write a polite order.', questions: ['writing', 'speaking'].includes(task.kind) ? [] : [question, question, question], memory },
  }[id]);
}

export class TestProvider {
  constructor(options = {}) { this.calls = []; this.options = options; }
  async complete({ system, prompt, signal }) {
    const id = Object.keys(agents).find(key => system.startsWith(`You are the ${agents[key].name} of`));
    const payload = JSON.parse(prompt.split('\nYour previous response')[0]);
    this.calls.push({ id, ...payload });
    if (this.options.block) await this.options.block(id);
    signal?.throwIfAborted();
    if (this.options.fail === id) return '{"broken":true}';
    return JSON.stringify(outputFor(id, payload.task));
  }
}
export function setup(options = {}) {
  const repository = new Repository(':memory:');
  const user = repository.createUser({ email: 'learner@example.com', name: 'Learner', passwordHash: '00'.repeat(64), passwordSalt: 'test', profile });
  const provider = new TestProvider(options);
  const settings = { provider: 'openai-compatible', model: 'test-model', apiKey: 'test-key', baseUrl: 'https://example.com/v1', timeoutMs: 3000 };
  const ai = new AIService(settings, { provider });
  const speech = new SpeechService({ provider: 'disabled' });
  const orchestrator = new AgentOrchestrator({ repository, ai, speech });
  return { repository, user, provider, ai, speech, orchestrator };
}
export function wav(seconds = 2) {
  const audio = Buffer.alloc(44 + seconds * 32000);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVE', 8); audio.write('fmt ', 12);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22); audio.writeUInt32LE(16000, 24);
  audio.writeUInt32LE(32000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34); audio.write('data', 36); audio.writeUInt32LE(seconds * 32000, 40);
  return audio;
}
