import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { rmSync } from 'node:fs';
import { Repository } from '../server/database.mjs';
import { outputFor, profile } from './fixtures.mjs';
import { escapeHTML } from '../public/views.js';

test('learning data survives a database restart and interrupted runs recover as failed', t => {
  const path = resolve(tmpdir(), `language-tutor-${randomUUID()}.sqlite`);
  let repo = new Repository(path);
  t.after(() => {
    repo.close();
    for (const file of [path, path + '-wal', path + '-shm']) rmSync(file, { force: true });
  });
  const user = repo.createUser({ email: 'persistent@example.com', name: 'Persistent', passwordHash: '00'.repeat(64), passwordSalt: 'test', profile });
  const run = repo.startRun(user.id, 'Spanish', 'conversation');
  const outputs = Object.fromEntries(['tutor', 'grammar', 'vocabulary', 'assessment', 'learningPath', 'progress'].map(id => [id, outputFor(id)]));
  repo.saveLearning({ userId: user.id, language: 'Spanish', runId: run, outputs, kind: 'conversation', input: { message: 'Yo tener café' }, durationSeconds: 60 });
  const interrupted = repo.startRun(user.id, 'Spanish', 'plan'); repo.startStep(interrupted, 'learningPath');
  repo.close(); repo = new Repository(path); repo.recoverInterruptedRuns();
  assert.equal(repo.conversation(user.id, 'Spanish').length, 2);
  assert.equal(repo.vocabulary(user.id, 'Spanish').length, 1);
  assert.equal(repo.stats(user.id, 'Spanish').sessions, 1);
  assert.equal(repo.insights(user.id, 'Spanish').recommendation.kind, 'quiz');
  assert.equal(repo.context(user.id, 'Spanish', 'tutor').agentMemory.length, 1);
  const recovered = repo.runs(user.id, 'Spanish').find(item => item.id === interrupted);
  assert.equal(recovered.status, 'failed'); assert.equal(recovered.steps[0].errorCode, 'SERVER_RESTARTED');
  assert.ok(repo.startRun(user.id, 'Spanish', 'plan'));
});

test('AI text is escaped before rendering into the interface', () => {
  assert.equal(escapeHTML('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHTML("<script>'&'</script>"), '&lt;script&gt;&#39;&amp;&#39;&lt;/script&gt;');
});
