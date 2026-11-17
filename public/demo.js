// Static product preview. These are sample records, never agent responses or live progress.
export const sample = {
  user: { name: 'Alex', email: 'Sample learner' },
  profile: { language: 'Spanish', nativeLanguage: 'English', level: 'A2', goal: 'Feel confident in everyday conversations and travel.', dailyMinutes: 20 },
  stats: { sessions: 12, streak: 7, weeklyMinutes: 94, totalWords: 84, dueWords: 8, practicedWords: 36,
    week: [8, 15, 12, 20, 9, 16, 14].map((minutes, i) => ({ date: new Date(Date.now() - (6 - i) * 86400000).toISOString().slice(0, 10), minutes })),
    recentScores: [{ score: 72, kind: 'quiz' }, { score: 81, kind: 'reading' }, { score: 85, kind: 'quiz' }] },
  vocabulary: [
    { id: 'sample-1', term: 'aprovechar', translation: 'to make the most of', example: 'Quiero aprovechar mi viaje para practicar español.', tags: ['travel'], dueAt: '2020-01-01', repetitions: 2 },
    { id: 'sample-2', term: 'la confianza', translation: 'confidence', example: 'Cada conversación me da más confianza.', tags: ['everyday'], dueAt: '2020-01-01', repetitions: 1 },
    { id: 'sample-3', term: 'pedir', translation: 'to order / to ask for', example: 'Me gustaría pedir un café, por favor.', tags: ['food'], dueAt: '2020-01-01', repetitions: 3 },
    { id: 'sample-4', term: 'aunque', translation: 'although / even though', example: 'Practico aunque a veces cometo errores.', tags: ['connectors'], dueAt: '2020-01-01', repetitions: 0 },
  ],
  conversation: [
    { role: 'assistant', content: '¡Hola, Alex! Imagine we’re in a little café in Madrid. The barista smiles and asks: “¿Qué te gustaría tomar?” What would you say?' },
    { role: 'user', content: 'Me gustaría un café con leche, por favor.' },
    { role: 'assistant', content: '¡Muy bien! That sounds natural and polite. ☕ Now the barista asks: “¿Quieres algo para comer?” How would you order a croissant?' },
  ],
  plan: { title: 'Everyday confidence', rationale: 'This sample plan combines conversation, useful vocabulary, and focused grammar practice.',
    focus: ['Everyday conversations', 'Past tense', 'Travel vocabulary'], activities: [
      { title: 'A conversation at the café', kind: 'conversation', durationMinutes: 10, objective: 'Practice ordering and asking follow-up questions.' },
      { title: 'Words you’ll actually use', kind: 'vocabulary', durationMinutes: 5, objective: 'Review useful travel vocabulary.' },
      { title: 'Tell me about yesterday', kind: 'writing', durationMinutes: 10, objective: 'Build confidence using the past tense.' },
      { title: 'A weekend in Barcelona', kind: 'listening', durationMinutes: 10, objective: 'Listen for the details in a short travel story.' },
    ] },
  insights: { summary: 'In this sample journey, consistent short sessions support growing confidence in everyday Spanish.', insights: ['Conversation is the most practiced skill.', 'A short vocabulary review makes a useful next activity.'], recommendation: { kind: 'conversation', title: 'A little café conversation', reason: 'Practice ordering, asking questions, and keeping the conversation going.' } },
  attempts: [], runs: [], activity: null,
};
