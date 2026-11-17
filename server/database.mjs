import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError } from './errors.mjs';
import { languageMap } from '../public/languages.js';

const parse = (value, fallback = null) => value ? JSON.parse(value) : fallback;
const now = () => new Date().toISOString();

export class Repository {
  constructor(path) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 5000;
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
        password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS profiles (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        language TEXT NOT NULL, native_language TEXT NOT NULL, level TEXT NOT NULL,
        goal TEXT NOT NULL, daily_minutes INTEGER NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS language_profiles (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, language TEXT NOT NULL,
        native_language TEXT NOT NULL, level TEXT NOT NULL, goal TEXT NOT NULL, daily_minutes INTEGER NOT NULL,
        preferences TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, PRIMARY KEY(user_id, language)
      );
      INSERT OR IGNORE INTO language_profiles SELECT user_id, language, native_language, level, goal, daily_minutes, '{}', updated_at FROM profiles;
      CREATE TABLE IF NOT EXISTS user_preferences (
        user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, preferences TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS tool_history (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        language TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES agent_runs(id), created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS communication_sessions (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        language_a TEXT NOT NULL, language_b TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS communication_turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES communication_sessions(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, speaker TEXT NOT NULL,
        source_language TEXT NOT NULL, target_language TEXT NOT NULL, transcript TEXT NOT NULL,
        translation TEXT NOT NULL, explanation TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS activities (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        language TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
        created_at TEXT NOT NULL, completed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        language TEXT NOT NULL, kind TEXT NOT NULL, activity_id TEXT REFERENCES activities(id),
        input TEXT NOT NULL, result TEXT NOT NULL, score REAL, duration_seconds INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        language TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS vocabulary (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        language TEXT NOT NULL, term TEXT NOT NULL, normalized_term TEXT NOT NULL,
        translation TEXT NOT NULL, example TEXT NOT NULL, tags TEXT NOT NULL,
        ease REAL NOT NULL DEFAULT 2.5, repetitions INTEGER NOT NULL DEFAULT 0,
        interval_days REAL NOT NULL DEFAULT 0, due_at TEXT NOT NULL, created_at TEXT NOT NULL,
        UNIQUE(user_id, language, normalized_term)
      );
      CREATE TABLE IF NOT EXISTS reviews (
        id TEXT PRIMARY KEY, word_id TEXT NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        rating TEXT NOT NULL, scheduled_days REAL NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS learning_plans (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        language TEXT NOT NULL, plan TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS learner_insights (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, language TEXT NOT NULL,
        insights TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, language)
      );
      CREATE TABLE IF NOT EXISTS agent_memories (
        user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, language TEXT NOT NULL,
        agent TEXT NOT NULL, memory TEXT NOT NULL, updated_at TEXT NOT NULL,
        PRIMARY KEY(user_id, language, agent)
      );
      CREATE TABLE IF NOT EXISTS agent_runs (
        id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        language TEXT NOT NULL, workflow TEXT NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON agent_runs(user_id, language) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS run_steps (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
        agent TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
        finished_at TEXT, output TEXT, error_code TEXT
      );
      CREATE INDEX IF NOT EXISTS attempt_history ON attempts(user_id, language, created_at);
      CREATE INDEX IF NOT EXISTS due_vocabulary ON vocabulary(user_id, language, due_at);
      CREATE INDEX IF NOT EXISTS conversation_history ON messages(user_id, language, created_at);
      CREATE INDEX IF NOT EXISTS run_history ON agent_runs(user_id, started_at);
      PRAGMA user_version = 2;
    `);
  }
  close() { this.db.close(); }
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  recoverInterruptedRuns() {
    this.transaction(() => {
      this.db.prepare("UPDATE run_steps SET status = 'failed', finished_at = ?, error_code = 'SERVER_RESTARTED' WHERE status = 'running'").run(now());
      this.db.prepare("UPDATE agent_runs SET status = 'failed', finished_at = ?, error_code = 'SERVER_RESTARTED' WHERE status = 'running'").run(now());
    });
  }
  userByEmail(email) { return this.db.prepare('SELECT * FROM users WHERE email = ?').get(email); }
  user(id) { return this.db.prepare('SELECT id, email, name, created_at FROM users WHERE id = ?').get(id); }
  createUser({ email, name, passwordHash, passwordSalt, profile }) {
    const id = randomUUID();
    this.transaction(() => {
      this.db.prepare('INSERT INTO users VALUES (?, ?, ?, ?, ?, ?)').run(id, email, name, passwordHash, passwordSalt, now());
      this.db.prepare('INSERT INTO profiles VALUES (?, ?, ?, ?, ?, ?, ?)').run(id, profile.language, profile.nativeLanguage, profile.level, profile.goal, profile.dailyMinutes, now());
      this.storeLanguageProfile(id, profile);
    });
    return this.user(id);
  }
  profile(userId, language) {
    const active = this.db.prepare('SELECT * FROM profiles WHERE user_id = ?').get(userId);
    const selected = language || active.language;
    const saved = this.db.prepare('SELECT * FROM language_profiles WHERE user_id = ? AND language = ?').get(userId, selected);
    const row = saved || active;
    return { language: selected, nativeLanguage: row.native_language, level: row.level, goal: row.goal, dailyMinutes: row.daily_minutes,
      dialect: '', accent: languageMap[selected]?.locale || '', teachingStyle: 'supportive', trainingFocus: 'general', ...parse(saved?.preferences, {}) };
  }
  storeLanguageProfile(userId, profile) {
    const preferences = { dialect: profile.dialect || '', accent: profile.accent || languageMap[profile.language]?.locale || '',
      teachingStyle: profile.teachingStyle || 'supportive', trainingFocus: profile.trainingFocus || 'general' };
    this.db.prepare(`INSERT INTO language_profiles VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, language)
      DO UPDATE SET native_language = excluded.native_language, level = excluded.level, goal = excluded.goal,
      daily_minutes = excluded.daily_minutes, preferences = excluded.preferences, updated_at = excluded.updated_at`)
      .run(userId, profile.language, profile.nativeLanguage, profile.level, profile.goal, profile.dailyMinutes, JSON.stringify(preferences), now());
  }
  profiles(userId) {
    return this.db.prepare('SELECT language FROM language_profiles WHERE user_id = ? ORDER BY updated_at DESC').all(userId)
      .map(row => ({ ...this.profile(userId, row.language), stats: this.stats(userId, row.language) }));
  }
  assertProfileEditable(userId) {
    if (this.db.prepare("SELECT 1 FROM agent_runs WHERE user_id = ? AND status = 'running'").get(userId)) {
      throw new AppError(409, 'WORKFLOW_BUSY', 'Wait for the current workflow to finish before changing your language profiles.');
    }
  }
  addProfile(userId, profile) {
    this.assertProfileEditable(userId); this.storeLanguageProfile(userId, profile); return this.profile(userId, profile.language);
  }
  selectProfile(userId, language) {
    this.assertProfileEditable(userId);
    if (!this.db.prepare('SELECT 1 FROM language_profiles WHERE user_id = ? AND language = ?').get(userId, language)) {
      throw new AppError(404, 'PROFILE_NOT_FOUND', 'Add this language profile before switching to it.');
    }
    return this.updateProfile(userId, this.profile(userId, language));
  }
  preferences(userId) {
    const row = this.db.prepare('SELECT preferences FROM user_preferences WHERE user_id = ?').get(userId);
    return { theme: 'system', translationSource: 'Auto', translationTarget: this.profile(userId).language, learnFromTools: true, ...parse(row?.preferences, {}) };
  }
  updatePreferences(userId, preferences) {
    this.db.prepare('INSERT INTO user_preferences VALUES (?, ?, ?) ON CONFLICT(user_id) DO UPDATE SET preferences = excluded.preferences, updated_at = excluded.updated_at')
      .run(userId, JSON.stringify({ ...this.preferences(userId), ...preferences }), now());
    return this.preferences(userId);
  }
  updateProfile(userId, profile) {
    if (this.db.prepare("SELECT 1 FROM agent_runs WHERE user_id = ? AND status = 'running'").get(userId)) {
      throw new AppError(409, 'WORKFLOW_BUSY', 'Wait for the current activity to finish before changing your learning preferences.');
    }
    this.transaction(() => {
      this.db.prepare('UPDATE profiles SET language = ?, native_language = ?, level = ?, goal = ?, daily_minutes = ?, updated_at = ? WHERE user_id = ?')
        .run(profile.language, profile.nativeLanguage, profile.level, profile.goal, profile.dailyMinutes, now(), userId);
      this.storeLanguageProfile(userId, profile);
    });
    return this.profile(userId);
  }
  addSession(tokenHash, userId, expiresAt) {
    this.db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(tokenHash, userId, expiresAt);
  }
  session(tokenHash) {
    return this.db.prepare('SELECT user_id FROM sessions WHERE token_hash = ? AND expires_at > ?').get(tokenHash, now());
  }
  removeSession(tokenHash) { this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(tokenHash); }
  conversation(userId, language) {
    return this.db.prepare('SELECT role, content, created_at FROM (SELECT rowid AS seq, role, content, created_at FROM messages WHERE user_id = ? AND language = ? ORDER BY rowid DESC LIMIT 20) ORDER BY seq')
      .all(userId, language);
  }
  plan(userId, language) {
    const row = this.db.prepare('SELECT * FROM learning_plans WHERE user_id = ? AND language = ? ORDER BY rowid DESC LIMIT 1').get(userId, language);
    return row ? { id: row.id, createdAt: row.created_at, ...parse(row.plan) } : null;
  }
  insights(userId, language) {
    const row = this.db.prepare('SELECT insights FROM learner_insights WHERE user_id = ? AND language = ?').get(userId, language);
    if (!row) return null;
    const { memory, ...insights } = parse(row.insights);
    return insights;
  }
  vocabulary(userId, language) {
    return this.db.prepare('SELECT * FROM vocabulary WHERE user_id = ? AND language = ? ORDER BY due_at LIMIT 300').all(userId, language)
      .map(row => ({ id: row.id, term: row.term, translation: row.translation, example: row.example,
        tags: parse(row.tags, []), dueAt: row.due_at, repetitions: row.repetitions, intervalDays: row.interval_days, ease: row.ease }));
  }
  word(userId, language, wordId) {
    const row = this.db.prepare('SELECT * FROM vocabulary WHERE id = ? AND user_id = ? AND language = ?').get(wordId, userId, language);
    if (!row) throw new AppError(404, 'WORD_NOT_FOUND', 'This vocabulary word was not found.');
    return row;
  }
  stats(userId, language) {
    const rows = this.db.prepare('SELECT created_at, duration_seconds, score, kind FROM attempts WHERE user_id = ? AND language = ? ORDER BY created_at DESC').all(userId, language);
    const weekStart = Date.now() - 7 * 86400000;
    const dates = new Set(rows.map(row => row.created_at.slice(0, 10)));
    let cursor = new Date();
    if (!dates.has(cursor.toISOString().slice(0, 10))) cursor.setUTCDate(cursor.getUTCDate() - 1);
    let streak = 0;
    while (dates.has(cursor.toISOString().slice(0, 10))) { streak++; cursor.setUTCDate(cursor.getUTCDate() - 1); }
    const week = Array.from({ length: 7 }, (_, i) => {
      const date = new Date(); date.setUTCDate(date.getUTCDate() - 6 + i);
      const day = date.toISOString().slice(0, 10);
      return { date: day, minutes: Math.round(rows.filter(row => row.created_at.startsWith(day)).reduce((sum, row) => sum + row.duration_seconds, 0) / 60) };
    });
    const counts = this.db.prepare('SELECT COUNT(*) AS total, SUM(CASE WHEN due_at <= ? THEN 1 ELSE 0 END) AS due, SUM(CASE WHEN repetitions >= 3 THEN 1 ELSE 0 END) AS practiced FROM vocabulary WHERE user_id = ? AND language = ?').get(now(), userId, language);
    return { sessions: rows.length, streak, weeklyMinutes: Math.round(rows.filter(row => Date.parse(row.created_at) >= weekStart).reduce((sum, row) => sum + row.duration_seconds, 0) / 60),
      totalWords: counts.total, dueWords: counts.due || 0, practicedWords: counts.practiced || 0, week,
      recentScores: rows.filter(row => row.score !== null).slice(0, 7).map(row => ({ score: row.score, kind: row.kind, date: row.created_at })) };
  }
  attempts(userId, language) {
    return this.db.prepare('SELECT id, activity_id, kind, result, score, created_at FROM attempts WHERE user_id = ? AND language = ? ORDER BY rowid DESC LIMIT 12')
      .all(userId, language).map(row => ({ id: row.id, activityId: row.activity_id, kind: row.kind, result: parse(row.result), score: row.score, createdAt: row.created_at }));
  }
  context(userId, language, agent) {
    const profile = this.profile(userId, language);
    const history = this.attempts(userId, language).slice(0, 6).map(attempt => ({ kind: attempt.kind, score: attempt.score, createdAt: attempt.createdAt,
      assessment: attempt.result.assessment, grammar: attempt.result.grammar ? { corrections: attempt.result.grammar.corrections } : undefined,
      progress: attempt.result.progress }));
    const memory = this.db.prepare('SELECT memory FROM agent_memories WHERE user_id = ? AND language = ? AND agent = ?').get(userId, language, agent);
    return { profile, statistics: this.stats(userId, language), recentPerformance: history,
      conversation: this.conversation(userId, language), learningPlan: this.plan(userId, language),
      vocabulary: this.vocabulary(userId, language).slice(0, 30), agentMemory: parse(memory?.memory, []) };
  }
  activity(userId, language, activityId) {
    const row = this.db.prepare('SELECT * FROM activities WHERE id = ? AND user_id = ? AND language = ?').get(activityId, userId, language);
    if (!row) throw new AppError(404, 'ACTIVITY_NOT_FOUND', 'This activity was not found.');
    return { id: row.id, kind: row.kind, content: parse(row.content), createdAt: row.created_at, completedAt: row.completed_at };
  }
  latestActivity(userId, language) {
    const row = this.db.prepare('SELECT id FROM activities WHERE user_id = ? AND language = ? ORDER BY rowid DESC LIMIT 1').get(userId, language);
    return row ? this.activity(userId, language, row.id) : null;
  }
  startRun(userId, language, workflow) {
    const id = randomUUID();
    try { this.db.prepare('INSERT INTO agent_runs (id, user_id, language, workflow, status, started_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, userId, language, workflow, 'running', now()); }
    catch (error) {
      if (String(error.message).includes('UNIQUE')) throw new AppError(409, 'WORKFLOW_BUSY', 'Another agent workflow is running. Please wait for it to finish.');
      throw error;
    }
    return id;
  }
  startStep(runId, agent) {
    const id = randomUUID();
    this.db.prepare('INSERT INTO run_steps (id, run_id, agent, status, started_at) VALUES (?, ?, ?, ?, ?)').run(id, runId, agent, 'running', now());
    return id;
  }
  finishStep(id, output, errorCode) {
    this.db.prepare('UPDATE run_steps SET status = ?, finished_at = ?, output = ?, error_code = ? WHERE id = ?')
      .run(errorCode ? 'failed' : 'completed', now(), output ? JSON.stringify(output) : null, errorCode || null, id);
  }
  finishRun(id, errorCode) {
    this.db.prepare('UPDATE agent_runs SET status = ?, finished_at = ?, error_code = ? WHERE id = ?')
      .run(errorCode ? 'failed' : 'completed', now(), errorCode || null, id);
  }
  runs(userId, language) {
    const rows = language ? this.db.prepare('SELECT * FROM agent_runs WHERE user_id = ? AND language = ? ORDER BY rowid DESC LIMIT 20').all(userId, language)
      : this.db.prepare('SELECT * FROM agent_runs WHERE user_id = ? ORDER BY rowid DESC LIMIT 20').all(userId);
    return rows.map(row => ({ id: row.id, language: row.language, workflow: row.workflow, status: row.status, startedAt: row.started_at, finishedAt: row.finished_at, errorCode: row.error_code,
        steps: this.db.prepare('SELECT agent, status, started_at, finished_at, error_code FROM run_steps WHERE run_id = ? ORDER BY rowid').all(row.id)
          .map(step => ({ agent: step.agent, status: step.status, startedAt: step.started_at, finishedAt: step.finished_at, errorCode: step.error_code })) }));
  }
  toolHistory(userId) {
    return this.db.prepare('SELECT id, language, tool, input, result, created_at FROM tool_history WHERE user_id = ? ORDER BY rowid DESC LIMIT 15').all(userId)
      .map(row => ({ id: row.id, language: row.language, tool: row.tool, input: parse(row.input), result: parse(row.result), createdAt: row.created_at }));
  }
  communication(userId, id) {
    const row = this.db.prepare('SELECT * FROM communication_sessions WHERE id = ? AND user_id = ?').get(id, userId);
    if (!row) throw new AppError(404, 'CONVERSATION_NOT_FOUND', 'This conversation translation session was not found.');
    const turns = this.db.prepare('SELECT speaker, source_language AS sourceLanguage, target_language AS targetLanguage, transcript, translation, explanation FROM (SELECT rowid AS seq, * FROM communication_turns WHERE session_id = ? AND user_id = ? ORDER BY rowid DESC LIMIT 20) ORDER BY seq').all(id, userId);
    return { id: row.id, languageA: row.language_a, languageB: row.language_b, turns };
  }
  search(userId, query) {
    const pattern = '%' + query.replace(/[\\%_]/g, '\\$&') + '%';
    const words = this.db.prepare("SELECT id, language, term, translation FROM vocabulary WHERE user_id = ? AND (term LIKE ? ESCAPE '\\' OR translation LIKE ? ESCAPE '\\') LIMIT 15").all(userId, pattern, pattern)
      .map(row => ({ type: 'word', id: row.id, title: row.term, description: `${row.language} · ${row.translation}`, route: 'vocabulary', language: row.language }));
    const lessons = this.db.prepare("SELECT id, language, kind, content FROM activities WHERE user_id = ? AND content LIKE ? ESCAPE '\\' ORDER BY rowid DESC LIMIT 15").all(userId, pattern)
      .map(row => ({ type: 'lesson', id: row.id, title: parse(row.content).title, description: `${row.language} · ${row.kind}`, route: 'practice', language: row.language }));
    return [...words, ...lessons];
  }
  saveLearning({ userId, language, outputs, kind, input, score, durationSeconds = 0, activityId, activity, review, runId, toolRecord, enrollProfile, communication }) {
    return this.transaction(() => {
      if (enrollProfile && !this.db.prepare('SELECT 1 FROM language_profiles WHERE user_id = ? AND language = ?').get(userId, language)) this.storeLanguageProfile(userId, enrollProfile);
      if (communication) {
        this.db.prepare('INSERT OR IGNORE INTO communication_sessions VALUES (?, ?, ?, ?, ?)').run(communication.id, userId, communication.languageA, communication.languageB, now());
        const turn = communication.turn;
        this.db.prepare('INSERT INTO communication_turns VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), communication.id, userId, turn.speaker, turn.sourceLanguage, turn.targetLanguage, turn.transcript, turn.translation, turn.explanation, now());
      }
      for (const [agent, result] of Object.entries(outputs)) {
        if (result.memory) this.db.prepare('INSERT INTO agent_memories VALUES (?, ?, ?, ?, ?) ON CONFLICT(user_id, language, agent) DO UPDATE SET memory = excluded.memory, updated_at = excluded.updated_at')
          .run(userId, language, agent, JSON.stringify(result.memory), now());
      }
      if (outputs.learningPath) this.db.prepare('INSERT INTO learning_plans VALUES (?, ?, ?, ?, ?)').run(randomUUID(), userId, language, JSON.stringify(outputs.learningPath), now());
      if (outputs.progress) this.db.prepare('INSERT INTO learner_insights VALUES (?, ?, ?, ?) ON CONFLICT(user_id, language) DO UPDATE SET insights = excluded.insights, updated_at = excluded.updated_at')
        .run(userId, language, JSON.stringify(outputs.progress), now());
      for (const word of outputs.vocabulary?.words || []) {
        this.db.prepare(`INSERT INTO vocabulary (id, user_id, language, term, normalized_term, translation, example, tags, due_at, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(user_id, language, normalized_term)
          DO UPDATE SET translation = excluded.translation, example = excluded.example, tags = excluded.tags`)
          .run(randomUUID(), userId, language, word.term, word.term.normalize('NFKC').toLocaleLowerCase(), word.translation, word.example, JSON.stringify(word.tags), now(), now());
      }
      let savedActivity;
      if (activity) {
        const id = randomUUID();
        this.db.prepare('INSERT INTO activities VALUES (?, ?, ?, ?, ?, ?, NULL)').run(id, userId, language, activity.kind, JSON.stringify(activity), now());
        savedActivity = this.activity(userId, language, id);
      }
      if (toolRecord) {
        if (savedActivity) toolRecord.result.practiceActivityId = savedActivity.id;
        this.db.prepare('INSERT INTO tool_history VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .run(randomUUID(), userId, language, toolRecord.tool, JSON.stringify(toolRecord.input), JSON.stringify(toolRecord.result), runId, now());
      }
      if (kind) {
        const id = randomUUID();
        const result = { ...outputs };
        if (input.speechEvidence) result.speechEvidence = input.speechEvidence;
        if (input.objectiveResults) result.objectiveResults = input.objectiveResults;
        this.db.prepare('INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
          .run(id, userId, language, kind, activityId || null, JSON.stringify(input), JSON.stringify(result), score === undefined ? outputs.assessment?.score ?? null : score, durationSeconds, now());
      }
      if (kind === 'conversation') {
        for (const [role, content] of [['user', input.message], ['assistant', outputs.tutor.reply]]) {
          this.db.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), userId, language, role, content, now());
        }
      }
      if (activityId) this.db.prepare('UPDATE activities SET completed_at = ? WHERE id = ? AND user_id = ? AND language = ?').run(now(), activityId, userId, language);
      if (review) {
        this.db.prepare('UPDATE vocabulary SET ease = ?, repetitions = ?, interval_days = ?, due_at = ? WHERE id = ? AND user_id = ? AND language = ?')
          .run(review.ease, review.repetitions, review.intervalDays, review.dueAt, review.wordId, userId, language);
        this.db.prepare('INSERT INTO reviews VALUES (?, ?, ?, ?, ?, ?)').run(randomUUID(), review.wordId, userId, review.rating, review.intervalDays, now());
      }
      this.finishRun(runId);
      return savedActivity;
    });
  }
}

export function publicActivity(activity) {
  if (!activity) return null;
  return { ...activity, content: { ...activity.content, memory: undefined,
    questions: activity.content.questions.map(({ prompt, options }) => ({ prompt, options })) } };
}
