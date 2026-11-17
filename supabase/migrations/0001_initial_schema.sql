-- ============================================================================
-- Migration: 0001_initial_schema.sql
-- Description: Initial PostgreSQL schema for Language Tutor Bot
-- Target: Supabase / PostgreSQL 15+
--
-- ARCHITECTURE AND SECURITY NOTE:
-- Authentication is managed by the custom Node.js backend using HttpOnly
-- session cookies (lt_session) and cryptographic scrypt / sha256 hashing.
-- Supabase Auth is NOT used in this phase.
--
-- The Node.js backend connects using a server-side Supabase secret key
-- (service_role), which bypasses Row Level Security (RLS).
-- The Node.js application server MUST explicitly enforce user isolation on
-- every single database operation by scoping queries with the authenticated
-- user_id (e.g. repo.requireUser(request)).
--
-- Direct access from public/anon/authenticated roles is denied by default
-- across all tables via enabled RLS with no public permissive policies.
-- ============================================================================

BEGIN;

-- ----------------------------------------------------------------------------
-- Extension setup
-- ----------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================================
-- 1. USERS
-- Corresponds to SQLite:
--   CREATE TABLE users (
--     id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE COLLATE NOCASE, name TEXT NOT NULL,
--     password_hash TEXT NOT NULL, password_salt TEXT NOT NULL, created_at TEXT NOT NULL
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- Case-insensitive uniqueness matching SQLite COLLATE NOCASE
CREATE UNIQUE INDEX IF NOT EXISTS users_email_nocase_idx ON users (LOWER(email));

-- ============================================================================
-- 2. SESSIONS
-- Corresponds to SQLite:
--   CREATE TABLE sessions (
--     token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL
);

-- ============================================================================
-- 3. PROFILES (Active single-language learner profile)
-- Corresponds to SQLite:
--   CREATE TABLE profiles (
--     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
--     language TEXT NOT NULL, native_language TEXT NOT NULL, level TEXT NOT NULL,
--     goal TEXT NOT NULL, daily_minutes INTEGER NOT NULL, updated_at TEXT NOT NULL
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  native_language TEXT NOT NULL,
  level TEXT NOT NULL,
  goal TEXT NOT NULL,
  daily_minutes INTEGER NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ============================================================================
-- 4. LANGUAGE_PROFILES (Multi-language learner profiles)
-- Corresponds to SQLite:
--   CREATE TABLE language_profiles (
--     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, language TEXT NOT NULL,
--     native_language TEXT NOT NULL, level TEXT NOT NULL, goal TEXT NOT NULL, daily_minutes INTEGER NOT NULL,
--     preferences TEXT NOT NULL DEFAULT '{}', updated_at TEXT NOT NULL, PRIMARY KEY(user_id, language)
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS language_profiles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  native_language TEXT NOT NULL,
  level TEXT NOT NULL,
  goal TEXT NOT NULL,
  daily_minutes INTEGER NOT NULL,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (user_id, language)
);

-- ============================================================================
-- 5. USER_PREFERENCES (UI preferences & tool settings)
-- Corresponds to SQLite:
--   CREATE TABLE user_preferences (
--     user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE, preferences TEXT NOT NULL, updated_at TEXT NOT NULL
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS user_preferences (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  preferences JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ============================================================================
-- 6. AGENT_RUNS (Workflow runs)
-- Corresponds to SQLite:
--   CREATE TABLE agent_runs (
--     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--     language TEXT NOT NULL, workflow TEXT NOT NULL, status TEXT NOT NULL,
--     started_at TEXT NOT NULL, finished_at TEXT, error_code TEXT
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  workflow TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  finished_at TIMESTAMPTZ,
  error_code TEXT
);

-- Existing Index: Prevents multiple concurrent running workflows per user & language
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run 
  ON agent_runs (user_id, language) 
  WHERE status = 'running';

-- Existing Index: User run history ordering
CREATE INDEX IF NOT EXISTS run_history 
  ON agent_runs (user_id, started_at);

-- ============================================================================
-- 7. RUN_STEPS (Individual agent steps within a workflow run)
-- Corresponds to SQLite:
--   CREATE TABLE run_steps (
--     id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
--     agent TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL,
--     finished_at TEXT, output TEXT, error_code TEXT
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS run_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  agent TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  finished_at TIMESTAMPTZ,
  output JSONB,
  error_code TEXT
);

-- ============================================================================
-- 8. TOOL_HISTORY (Records of tool usage)
-- Corresponds to SQLite:
--   CREATE TABLE tool_history (
--     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--     language TEXT NOT NULL, tool TEXT NOT NULL, input TEXT NOT NULL, result TEXT NOT NULL,
--     run_id TEXT NOT NULL REFERENCES agent_runs(id), created_at TEXT NOT NULL
--   );
-- Note: SQLite does not specify ON DELETE for run_id (defaults to NO ACTION).
-- ============================================================================
CREATE TABLE IF NOT EXISTS tool_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  tool TEXT NOT NULL,
  input JSONB NOT NULL,
  result JSONB NOT NULL,
  run_id UUID NOT NULL REFERENCES agent_runs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ============================================================================
-- 9. COMMUNICATION_SESSIONS (Multi-language interpreter sessions)
-- Corresponds to SQLite:
--   CREATE TABLE communication_sessions (
--     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--     language_a TEXT NOT NULL, language_b TEXT NOT NULL, created_at TEXT NOT NULL
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS communication_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language_a TEXT NOT NULL,
  language_b TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ============================================================================
-- 10. COMMUNICATION_TURNS (Individual turns in interpreter sessions)
-- Corresponds to SQLite:
--   CREATE TABLE communication_turns (
--     id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES communication_sessions(id) ON DELETE CASCADE,
--     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, speaker TEXT NOT NULL,
--     source_language TEXT NOT NULL, target_language TEXT NOT NULL, transcript TEXT NOT NULL,
--     translation TEXT NOT NULL, explanation TEXT NOT NULL, created_at TEXT NOT NULL
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS communication_turns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES communication_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  speaker TEXT NOT NULL,
  source_language TEXT NOT NULL,
  target_language TEXT NOT NULL,
  transcript TEXT NOT NULL,
  translation TEXT NOT NULL,
  explanation TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ============================================================================
-- 11. ACTIVITIES (Practice & learning activities)
-- Corresponds to SQLite:
--   CREATE TABLE activities (
--     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--     language TEXT NOT NULL, kind TEXT NOT NULL, content TEXT NOT NULL,
--     created_at TEXT NOT NULL, completed_at TEXT
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  kind TEXT NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  completed_at TIMESTAMPTZ
);

-- ============================================================================
-- 12. ATTEMPTS (Learner answers and evaluation scores)
-- Corresponds to SQLite:
--   CREATE TABLE attempts (
--     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--     language TEXT NOT NULL, kind TEXT NOT NULL, activity_id TEXT REFERENCES activities(id),
--     input TEXT NOT NULL, result TEXT NOT NULL, score REAL, duration_seconds INTEGER NOT NULL,
--     created_at TEXT NOT NULL
--   );
-- Note: SQLite does not specify ON DELETE for activity_id (defaults to NO ACTION).
-- ============================================================================
CREATE TABLE IF NOT EXISTS attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  kind TEXT NOT NULL,
  activity_id UUID REFERENCES activities(id),
  input JSONB NOT NULL,
  result JSONB NOT NULL,
  score DOUBLE PRECISION,
  duration_seconds INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- Existing Index: Attempt history per user, language, and date
CREATE INDEX IF NOT EXISTS attempt_history 
  ON attempts (user_id, language, created_at);

-- ============================================================================
-- 13. MESSAGES (Conversational dialogue with tutor)
-- Corresponds to SQLite:
--   CREATE TABLE messages (
--     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--     language TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, created_at TEXT NOT NULL
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  role TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- Existing Index: Conversation history per user, language, and date
CREATE INDEX IF NOT EXISTS conversation_history 
  ON messages (user_id, language, created_at);

-- ============================================================================
-- 14. VOCABULARY (Spaced repetition word bank)
-- Corresponds to SQLite:
--   CREATE TABLE vocabulary (
--     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--     language TEXT NOT NULL, term TEXT NOT NULL, normalized_term TEXT NOT NULL,
--     translation TEXT NOT NULL, example TEXT NOT NULL, tags TEXT NOT NULL,
--     ease REAL NOT NULL DEFAULT 2.5, repetitions INTEGER NOT NULL DEFAULT 0,
--     interval_days REAL NOT NULL DEFAULT 0, due_at TEXT NOT NULL, created_at TEXT NOT NULL,
--     UNIQUE(user_id, language, normalized_term)
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS vocabulary (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  term TEXT NOT NULL,
  normalized_term TEXT NOT NULL,
  translation TEXT NOT NULL,
  example TEXT NOT NULL,
  tags JSONB NOT NULL DEFAULT '[]'::jsonb,
  ease DOUBLE PRECISION NOT NULL DEFAULT 2.5,
  repetitions INTEGER NOT NULL DEFAULT 0,
  interval_days DOUBLE PRECISION NOT NULL DEFAULT 0,
  due_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  CONSTRAINT vocabulary_user_language_normalized_term_key UNIQUE (user_id, language, normalized_term)
);

-- Existing Index: Due vocabulary retrieval
CREATE INDEX IF NOT EXISTS due_vocabulary 
  ON vocabulary (user_id, language, due_at);

-- ============================================================================
-- 15. REVIEWS (Spaced repetition review logs)
-- Corresponds to SQLite:
--   CREATE TABLE reviews (
--     id TEXT PRIMARY KEY, word_id TEXT NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
--     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--     rating TEXT NOT NULL, scheduled_days REAL NOT NULL, created_at TEXT NOT NULL
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  word_id UUID NOT NULL REFERENCES vocabulary(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  rating TEXT NOT NULL,
  scheduled_days DOUBLE PRECISION NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ============================================================================
-- 16. LEARNING_PLANS (Customized curriculum roadmap)
-- Corresponds to SQLite:
--   CREATE TABLE learning_plans (
--     id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
--     language TEXT NOT NULL, plan TEXT NOT NULL, created_at TEXT NOT NULL
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS learning_plans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  plan JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now())
);

-- ============================================================================
-- 17. LEARNER_INSIGHTS (Diagnostics, strengths & weakness tracking)
-- Corresponds to SQLite:
--   CREATE TABLE learner_insights (
--     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, language TEXT NOT NULL,
--     insights TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(user_id, language)
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS learner_insights (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  insights JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (user_id, language)
);

-- ============================================================================
-- 18. AGENT_MEMORIES (Cross-session memory for agent roles)
-- Corresponds to SQLite:
--   CREATE TABLE agent_memories (
--     user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, language TEXT NOT NULL,
--     agent TEXT NOT NULL, memory TEXT NOT NULL, updated_at TEXT NOT NULL,
--     PRIMARY KEY(user_id, language, agent)
--   );
-- ============================================================================
CREATE TABLE IF NOT EXISTS agent_memories (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  language TEXT NOT NULL,
  agent TEXT NOT NULL,
  memory JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT timezone('utc', now()),
  PRIMARY KEY (user_id, language, agent)
);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS)
--
-- Defense-in-depth: Enable RLS on all 18 tables.
-- By enabling RLS without granting public or authenticated policies, any
-- direct request through the browser/client SDK (anon role) is rejected.
-- Only the server-side backend holding the service_role key can access
-- the data.
-- ============================================================================
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE language_profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_steps ENABLE ROW LEVEL SECURITY;
ALTER TABLE tool_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE vocabulary ENABLE ROW LEVEL SECURITY;
ALTER TABLE reviews ENABLE ROW LEVEL SECURITY;
ALTER TABLE learning_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE learner_insights ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memories ENABLE ROW LEVEL SECURITY;

COMMIT;

-- ============================================================================
-- MIGRATION VERIFICATION CHECKLIST
--
-- 1. Table Count:
--    Ensure exactly 18 tables are created:
--    SELECT count(*) FROM information_schema.tables
--    WHERE table_schema = 'public' AND table_type = 'BASE TABLE';
--    Expected: 18
--
-- 2. Constraints & Uniqueness:
--    - users: PRIMARY KEY (id), UNIQUE INDEX on LOWER(email).
--    - sessions: PRIMARY KEY (token_hash).
--    - profiles: PRIMARY KEY (user_id).
--    - language_profiles: PRIMARY KEY (user_id, language).
--    - user_preferences: PRIMARY KEY (user_id).
--    - agent_memories: PRIMARY KEY (user_id, language, agent).
--    - learner_insights: PRIMARY KEY (user_id, language).
--    - vocabulary: PRIMARY KEY (id), UNIQUE (user_id, language, normalized_term).
--
-- 3. Foreign Keys & Cascades:
--    - Check ON DELETE CASCADE on all tables referencing users(id).
--    - Check ON DELETE CASCADE on run_steps -> agent_runs(id).
--    - Check ON DELETE CASCADE on communication_turns -> communication_sessions(id).
--    - Check ON DELETE CASCADE on reviews -> vocabulary(id).
--    - Check NO ACTION on tool_history -> agent_runs(id).
--    - Check NO ACTION on attempts -> activities(id).
--
-- 4. Indexes (5 SQLite indexes preserved):
--    - one_active_run: UNIQUE partial index on agent_runs (user_id, language) WHERE status = 'running'.
--    - run_history: index on agent_runs (user_id, started_at).
--    - attempt_history: index on attempts (user_id, language, created_at).
--    - due_vocabulary: index on vocabulary (user_id, language, due_at).
--    - conversation_history: index on messages (user_id, language, created_at).
--
-- 5. Row Level Security:
--    Verify RLS is active across all 18 tables:
--    SELECT tablename, rowsecurity FROM pg_tables WHERE schemaname = 'public';
--    Expected: rowsecurity = true for all 18 tables.
--
-- 6. UUID & Types Validity:
--    - All PK / FK identifiers accept standard RFC 4122 UUID strings generated
--      by crypto.randomUUID() in Node.js.
--    - Timestamp columns accept ISO 8601 strings and preserve UTC offsets.
--    - JSONB columns accept object and array literals matching parse(...) calls.
-- ============================================================================
