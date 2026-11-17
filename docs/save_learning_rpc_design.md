# Design Document: Atomic save_learning Stored Procedure

## 1. Overview and Problem Statement

In the existing Language Tutor Bot architecture, the method [`saveLearning`](file:///e:/language-tutor/server/database.mjs#L312) in `server/database.mjs` executes up to 13 discrete SQL statements inside a synchronous transaction block:
```javascript
this.transaction(() => { ... }); // BEGIN IMMEDIATE ... COMMIT
```

Because Supabase operations across the HTTP REST API (PostgREST) are executed as separate HTTP requests, multiple individual `fetch` or `.insert()` calls would lack transaction boundaries. An intermittent network error, process restart, or constraint failure midway through writing an activity or vocabulary review would leave learner progress in an inconsistent or corrupt state.

To guarantee ACID guarantees in PostgreSQL, the entire `saveLearning` workflow must be encapsulated inside a single atomic PostgreSQL RPC function (`save_learning`).

---

## 2. Participating Tables and Operations

The following tables participate in `saveLearning`:

1. **`language_profiles`**:
   - Condition: `enrollProfile` passed and no row exists for `(user_id, language)`.
   - Action: `INSERT INTO language_profiles` with initial preferences.
2. **`communication_sessions`**:
   - Condition: `communication` object passed.
   - Action: `INSERT ... ON CONFLICT (id) DO NOTHING` for the session header.
3. **`communication_turns`**:
   - Condition: `communication` object passed.
   - Action: `INSERT INTO communication_turns` recording speaker, transcript, translation, and explanation.
4. **`agent_memories`**:
   - Condition: Any agent entry in `outputs` contains `.memory`.
   - Action: Loop and `INSERT ... ON CONFLICT (user_id, language, agent) DO UPDATE SET memory, updated_at`.
5. **`learning_plans`**:
   - Condition: `outputs.learningPath` is present.
   - Action: `INSERT INTO learning_plans` with new plan JSONB.
6. **`learner_insights`**:
   - Condition: `outputs.progress` is present.
   - Action: `INSERT ... ON CONFLICT (user_id, language) DO UPDATE SET insights, updated_at`.
7. **`vocabulary`**:
   - Condition: `outputs.vocabulary.words` array is present.
   - Action: Loop and `INSERT ... ON CONFLICT (user_id, language, normalized_term) DO UPDATE SET translation, example, tags`.
   - Condition: `review` object passed.
   - Action: `UPDATE vocabulary SET ease, repetitions, interval_days, due_at WHERE id = review.wordId`.
8. **`activities`**:
   - Condition: `activity` object passed.
   - Action: `INSERT INTO activities` returning generated activity ID.
   - Condition: `activityId` argument passed.
   - Action: `UPDATE activities SET completed_at = now() WHERE id = activityId`.
9. **`tool_history`**:
   - Condition: `toolRecord` object passed.
   - Action: Updates `toolRecord.result.practiceActivityId` if an activity was created, then `INSERT INTO tool_history`.
10. **`attempts`**:
    - Condition: `kind` argument passed.
    - Action: `INSERT INTO attempts` recording inputs, outputs, score, and duration.
11. **`messages`**:
    - Condition: `kind === 'conversation'`.
    - Action: Inserts 2 consecutive messages:
      - `role = 'user'`, content = `input.message`
      - `role = 'assistant'`, content = `outputs.tutor.reply`
12. **`reviews`**:
    - Condition: `review` object passed.
    - Action: `INSERT INTO reviews` recording rating and scheduled days.
13. **`agent_runs`**:
    - Always executed at the end of `saveLearning`:
    - Action: `UPDATE agent_runs SET status = 'completed', finished_at = now(), error_code = NULL WHERE id = runId`.

---

## 3. Proposed Function Signature

```sql
CREATE OR REPLACE FUNCTION save_learning(
  p_user_id UUID,
  p_language TEXT,
  p_run_id UUID,
  p_outputs JSONB,
  p_kind TEXT DEFAULT NULL,
  p_input JSONB DEFAULT NULL,
  p_score DOUBLE PRECISION DEFAULT NULL,
  p_duration_seconds INTEGER DEFAULT 0,
  p_activity_id UUID DEFAULT NULL,
  p_activity JSONB DEFAULT NULL,
  p_review JSONB DEFAULT NULL,
  p_tool_record JSONB DEFAULT NULL,
  p_enroll_profile JSONB DEFAULT NULL,
  p_communication JSONB DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
...
$$;
```

---

## 4. Returned Payload

The function returns the saved activity record formatted as JSONB:
```json
{
  "id": "uuid-here",
  "kind": "quiz",
  "content": { ... },
  "createdAt": "2026-11-17T08:30:00Z",
  "completedAt": null
}
```
Or `NULL` if no activity was generated in this step.

---

## 5. Next Steps for Implementation

1. Create a follow-up migration `supabase/migrations/0002_save_learning_rpc.sql` containing the plpgsql function definition.
2. In the Node.js repository, call this function via `supabase.rpc('save_learning', { ... })`.
3. Verify that all 13 table updates either commit together or roll back completely on error.
