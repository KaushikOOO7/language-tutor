import { str, num, arr, obj, enumeration } from '../ai/schema.mjs';
import { activityKinds, levels } from '../config.mjs';
import { languageAgents } from './language-agents.mjs';

const memory = arr(str(350), 8);
const correction = obj({ original: str(500), corrected: str(500), explanation: str(1000), topic: str(100) });
const word = obj({ term: str(100), translation: str(200), example: str(500), tags: arr(str(60), 4) });
const recommendation = obj({ kind: enumeration(activityKinds), title: str(120), reason: str(1000) });
const question = obj({ prompt: str(1000), options: arr(str(400), 4, 2), answerIndex: { type: 'integer', minimum: 0, maximum: 3 }, explanation: str(1000) });

export const agents = {
  ...languageAgents,
  tutor: {
    name: 'AI Language Tutor Agent', description: 'Natural conversation, adapted to your level.',
    instructions: 'Conduct a natural, encouraging conversation. Respond to the learner and keep it moving with one useful question. Use recent conversation history for continuity. Never answer on behalf of the learner. Return a short nextPrompt the learner could respond to.',
    schema: obj({ reply: str(6000), nextPrompt: str(600), memory }),
  },
  speaking: {
    name: 'Speaking Agent', description: 'Speech, pronunciation, and speaking feedback.',
    instructions: 'Evaluate the supplied actual transcript and speech measurements. Give concrete speaking exercises and language feedback. Audio pronunciation and acoustic fluency scores only exist if the speech service supplied them. If absent, explicitly state that pronunciation was not measured. Do not infer accent, pronunciation, timing or acoustic fluency from text. Focus on expressiveness and sentence construction when transcript-only.',
    schema: obj({ feedback: str(4000), strengths: arr(str(500), 5), improvements: arr(str(500), 5), exercises: arr(str(1000), 4), memory }),
  },
  grammar: {
    name: 'Grammar Agent', description: 'Understand mistakes and practice the patterns.',
    instructions: 'Identify actual mistakes in the learner input, explain the pattern clearly, and create relevant exercises. Return empty corrections if no mistakes exist. Do not invent errors or correct the tutor text. Exercise answerIndex must refer to an existing option.',
    schema: obj({ explanation: str(3000), corrections: arr(correction, 8), exercises: arr(question, 3), memory }),
  },
  vocabulary: {
    name: 'Vocabulary Agent', description: 'Useful words, with spaced repetition.',
    instructions: 'Select up to 6 useful words from the supplied learning interaction. Prioritize the learner goals and unfamiliar vocabulary. Provide natural examples and native-language translations. The database schedules reviews; do not invent due dates or review completion. For review tasks, use the real recall history to recommend practice.',
    schema: obj({ words: arr(word, 6), advice: str(1800), memory }),
  },
  learningPath: {
    name: 'Learning Path Agent', description: 'A plan that grows with your progress.',
    instructions: 'Create or update a realistic plan based on real attempts, mistakes, review needs, goals and other agent findings. Use all activity kinds as appropriate and the learner daily time budget. Never restrict access to any tool based on level. Provide 3 to 6 actionable activities; this is a recommendation, not proof that the activities were completed.',
    schema: obj({ title: str(160), rationale: str(2500), focus: arr(str(200), 5), activities: arr(obj({ title: str(160), kind: enumeration(activityKinds), durationMinutes: { type: 'integer', minimum: 2, maximum: 60 }, objective: str(600) }), 6, 3), memory }),
  },
  assessment: {
    name: 'Assessment Agent', description: 'Find strengths and the next area to improve.',
    instructions: 'Assess only the supplied learner performance. Use objective quiz/review results when provided. The score is an educational estimate, not an official CEFR certificate. Do not equate a short conversation with a formal proficiency exam. Identify specific strengths and weaknesses with evidence.',
    schema: obj({ feedback: str(3000), estimatedLevel: enumeration(levels), score: num(), strengths: arr(str(500), 5), weaknesses: arr(str(500), 5), topics: arr(obj({ topic: str(120), mastery: num() }), 6), memory }),
  },
  progress: {
    name: 'Progress Analysis Agent', description: 'Turn learning activity into a useful next step.',
    instructions: 'Analyze actual persisted learning activity and the current interaction. Explain what the evidence supports and suggest the next best activity. With no history, say that more practice is needed before identifying a trend. Never fabricate streaks, minutes, vocabulary mastery or improvement percentages.',
    schema: obj({ summary: str(3000), insights: arr(str(800), 5), recommendation, memory }),
  },
  content: {
    name: 'Content Agent', description: 'Personal lessons, reading, listening, and quizzes.',
    instructions: 'Generate a complete activity of the requested kind, appropriate to the target language and goals. Write original learning material. For lesson, quiz, reading and listening provide 3 to 5 questions; for speaking provide a short read-aloud referenceText and an empty questions array; for writing provide a writingPrompt and an empty questions array. For listening include listeningText for the device text-to-speech voice. Unused text fields must contain a brief relevant description, not be empty. Question answerIndex must refer to an existing option. Keep referenceText under 600 characters for speech analysis.',
    schema: obj({ title: str(160), kind: enumeration(activityKinds), instructions: str(2200), text: str(6000), referenceText: str(600), listeningText: str(3500), writingPrompt: str(1200), questions: arr(question, 5), memory }),
  },
};

export function validateAgentSemantics(id, result, task) {
  for (const item of id === 'content' ? result.questions : id === 'grammar' ? result.exercises : []) {
    if (item.answerIndex >= item.options.length) throw new Error('Question answer index is outside its options.');
  }
  if (id === 'content') {
    if (result.kind !== task.kind) throw new Error('Content does not match the requested activity kind.');
    if (['lesson', 'quiz', 'reading', 'listening'].includes(result.kind) && result.questions.length < 3) {
      throw new Error('This activity requires at least three questions.');
    }
    if (['writing', 'speaking'].includes(result.kind) && result.questions.length) throw new Error('Writing and speaking require a free response.');
  }
}
