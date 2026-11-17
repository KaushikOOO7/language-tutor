# Language Tutor Bot

An AI language ecosystem with **14 coordinated agents**, **17 language tools**, **95 language choices**, multiple saved learning profiles, shared learner memory, and a responsive interface with light and dark themes. Every account has the same tools. Agents personalize difficulty, pacing, teaching style, regional context, and recommendations.

The catalog includes Kannada, Hindi, Tamil, Telugu, Malayalam, Bengali, Marathi, Gujarati, Punjabi, Assamese, Odia, and additional Indian, global, and regional languages. Language and script choices are not a guarantee of model accuracy or speech/OCR availability; each external provider has its own coverage.

Main navigation includes Home, Learn, AI Tutor, Translate, Speaking, Grammar, Vocabulary, Writing, Listening, Dictionary, Documents, Progress, and Profile. A dedicated Language Tools catalog organizes advanced tools. Search (Ctrl/Cmd K) finds tools, learning resources, language profiles, and the authenticated learner's saved words and activities.

See [the architecture and implemented phases](docs/architecture.md) for delegation, persistence, and service boundaries.

## Run locally

Requires **Node.js 24 or newer**. No package installation or build step is needed.

```powershell
Copy-Item .env.example .env
npm start
```

Open **http://localhost:3000**. Without an AI provider, the app displays an explicitly labeled product preview. You can create a real account and save multiple language profiles and preferences. Agent workflows need AI configuration. Device text-to-speech works with an installed voice, and speech-to-text can use a configured speech service independently of AI. Preview conversations, words, plans, and statistics are static sample data; they are never copied into accounts. Tools do not generate fake translations, OCR, audio scores, or agent responses. There is no production mock provider.

## Language tools

| Tool | Actual implementation and requirements |
| --- | --- |
| AI Text Translator | Structured Translation Agent; optional Azure Translator evidence; AI credentials |
| Voice Translator | Real recorded WAV → transcription → translation → optional connected learning; speech + AI |
| Camera Translator | Browser camera capture → real OCR → translation; camera access + OCR + AI |
| Image Translator | PNG/JPEG upload → real OCR → translation; OCR + AI |
| Live Conversation Translator | Owned two-person sessions with typed or recorded turns; AI, plus speech for voice |
| Document Translator | Bounded TXT, Markdown, CSV, HTML, DOCX extraction; OCR for PDF; Document Translation Agent; AI |
| Website & Text Translator | Pasted text/HTML or safe public HTTPS text extraction; AI |
| AI Grammar Checker | Grammar Agent corrections and Writing Agent revision; AI |
| AI Writing Assistant | Purpose/tone-aware revision with grammar coordination; AI |
| AI Paraphrasing Tool | Meaning-preserving alternatives and change explanations; AI |
| AI Summarizer | Summary in the selected target language; AI |
| Dictionary | Definitions, examples, synonyms, antonyms and cultural usage; AI |
| Pronunciation Tool | Phonetic guidance, installed device voice, and read-aloud practice; AI guidance, speech for measurements |
| Transliteration Tool | Script conversion without translation; AI or configured Azure transliteration |
| Language Detection | AI estimate or actual Azure detection score, with uncertainty labeled |
| Text-to-Speech | Installed browser/device voice; no AI key required; no audio download |
| Speech-to-Text | Actual speech service transcription; editable text; AI explanation optional |

Enable “Help me learn from this result” to coordinate pronunciation, grammar, vocabulary, content, learning path, and progress agents. The system saves target-language words and generates a quiz. New language enrollment and all learning updates commit only after the complete workflow succeeds. Generated practice is not marked completed. The active language changes only when the learner explicitly opens or switches to that language.

Learning resources include daily lessons, reading, writing, listening, original exam practice, business communication, travel, roleplay, cultural expressions, idioms, grammar, and pronunciation. These are original generated activities, not official exam papers or certifications.

## Configure live AI

Set these values in `.env` and restart the server:

```dotenv
AI_PROVIDER=openai-compatible
AI_MODEL=your-available-model
AI_API_KEY=your-api-key
AI_BASE_URL=https://api.openai.com/v1
```

Choose a model that supports chat completions and JSON object output. Other OpenAI-compatible endpoints work through the same adapter if they support `response_format: {type: "json_object"}` and `max_tokens`. Local endpoints can use an explicit `AI_ALLOW_KEYLESS=true`. Remote endpoints must use HTTPS. Do not put keys in frontend files.

For compatible models that use `max_completion_tokens`, set `AI_TOKEN_PARAMETER=max_completion_tokens`. `AI_MAX_OUTPUT_TOKENS` defaults to 8,000 and can be set within 512–16,000 according to the model's limits. Long translations and documents use bounded sections to support different scripts without claiming unlimited input or output sizes.

For Anthropic:

```dotenv
AI_PROVIDER=anthropic
AI_MODEL=your-available-model
AI_API_KEY=your-api-key
AI_BASE_URL=https://api.anthropic.com/v1
```

The Anthropic adapter uses a required structured response tool. Both adapters validate all agent responses against their JSON schemas and reject inconsistent quiz keys and activity kinds. Malformed structured responses get one correction attempt. Provider errors, quotas, network failures, and timeouts are reported without exposing upstream responses or credentials. A configured badge means settings are present; it does not claim the provider connection has been tested.

AI calls are billable according to the configured provider. A conversation normally invokes six agents. Workflows can invoke independent agents concurrently, while dependent agents receive earlier outputs. Rate limits apply equally to every account.

## Configure speech

**Actual pronunciation and acoustic fluency:** configure an Azure Speech resource.

```dotenv
SPEECH_PROVIDER=azure
SPEECH_API_KEY=your-speech-resource-key
AZURE_SPEECH_REGION=your-resource-region
SPEECH_PRONUNCIATION_LOCALES=en-US,en-GB,es-ES,fr-FR
```

The browser captures real microphone audio and creates mono 16 kHz PCM WAV. The server validates the format, then submits the recording and the generated read-aloud reference to Azure pronunciation assessment. Enable only locales supported by your resource. Ordinary transcription does not use pronunciation assessment and can recognize additional supported languages, including Kannada when supported by the speech resource. Missing or invalid measurements produce an error instead of fabricated scores. The UI displays actual accuracy, fluency, completeness, and pronunciation, with feedback from the Speaking and Pronunciation Coach Agents.

**Transcription and language feedback:** use a compatible transcription service.

```dotenv
SPEECH_PROVIDER=openai-compatible
SPEECH_API_KEY=your-transcription-key
SPEECH_BASE_URL=https://api.openai.com/v1
SPEECH_MODEL=whisper-1
```

This option transcribes the recording and provides speaking-language feedback. It **does not measure pronunciation or acoustic fluency**, and the UI says so. Recordings must be 1–60 seconds. Audio is held transiently and sent to the configured speech provider; audio bytes are not persisted. Transcripts and valid measurements are saved as learner evidence. Microphone access needs localhost or HTTPS. Listening exercises use an installed browser/device voice, not AI-generated audio; if the target-language voice is missing, the app asks the learner to install one.

## Configure OCR and optional Azure text services

Images, camera captures, and PDFs need Azure Document Intelligence:

```dotenv
OCR_PROVIDER=azure-document-intelligence
OCR_API_KEY=your-resource-key
OCR_BASE_URL=https://your-resource.cognitiveservices.azure.com
```

The adapter uses API version `2024-11-30` and the asynchronous `prebuilt-read` model. It polls the actual operation, rejects empty/failed extraction, and validates the operation URL before sending credentials. Uploaded files are limited to 8 MB and extracted text to 24,000 characters. Documents are translated in bounded sections and downloaded as plain UTF-8 text. Source layout, signatures, images, and PDF formatting are not reconstructed. Scanned PDFs need OCR; encrypted PDFs may be rejected by the provider. DOCX extraction reads the document body and does not promise headers, footnotes, embedded images, or original layout.

Text translation defaults to the configured LLM. To use Azure Translator as actual translation evidence:

```dotenv
TRANSLATION_PROVIDER=azure
TRANSLATION_API_KEY=your-translator-key
TRANSLATION_REGION=your-resource-region
TRANSLATION_BASE_URL=https://api.cognitive.microsofttranslator.com
```

AI configuration is still required for collaborating agents and explanations. Azure translation checks supported languages against its live catalogue; unsupported pairs fail explicitly. Detection and transliteration can use Azure results. Agent outputs cannot silently replace actual Azure translation evidence. Model-based detection confidence and phonetic guidance are explicitly estimates.

Website translation accepts public HTTPS pages with readable HTML/plain text. It blocks private/internal addresses and credentials, pins DNS, revalidates redirects, limits bytes, strips active content, and never executes website scripts. Pages requiring sign-in, inaccessible pages, non-UTF-8/compressed responses, and pages requiring client-side JavaScript need pasted content. Live conversation translation uses short turns; continuous simultaneous interpretation is not implemented.

## Connected learning workflows

| Workflow | Agents and learning tools |
| --- | --- |
| Conversation | Tutor + Grammar → Assessment + Vocabulary → Learning Path → Progress |
| Generate activity | Learning Path → Content → Vocabulary + Progress |
| Assess reading, writing, lesson, quiz, listening | Assessment + Grammar → Vocabulary → Learning Path → Progress |
| Speaking | Real speech service → Speaking + Assessment → Grammar + Vocabulary → Learning Path → Progress |
| Vocabulary review | Vocabulary + Assessment → Learning Path → Progress; SM-2 style scheduling |
| Plan and progress | Learning Path → Progress using saved learning history |
| Language tools | Translation / Writing / Document / Voice / Culture agents, with shared memory and actual service evidence |
| Learn from a tool result | Pronunciation + Grammar + Vocabulary → Content quiz → Learning Path → Progress |

The Content Agent generates actual lessons, quizzes, reading passages, writing prompts, listening texts, and read-aloud exercises. Quiz keys are kept server-side until the learner submits. The learning engine computes quiz results from saved keys; it never accepts a client-supplied score. Grammar corrections can launch a generated quiz for that pattern. Recall ratings are self-reported and affect review scheduling; they are not proficiency scores.

Each agent receives the learner profile, recent performance, conversation, current plan, useful vocabulary, statistics, its own persisted memory, and relevant earlier agent outputs. The orchestrator saves learning changes, new words, agent memories, plan revisions, assessment evidence, and progress recommendations in one transaction after the workflow succeeds. Failed runs retain an audit trace without applying partial learning changes. Actual running and completed agent steps are visible on the AI team page. The frontend polls real run records during requests.

Data is scoped to both the authenticated learner and the target language. Each saved profile retains its level, goals, daily minutes, native language, dialect preference, regional locale, teaching style, focus, and progress. Switching back restores that profile. Appearance and translation defaults are account preferences. No level, subscription, or account type restricts tools. CEFR and mastery estimates from short activities are informal educational feedback, not certification. Activity time comes from visible browser time or measured recording duration; streak days use UTC.

## Structure

```text
server/
  app.mjs                  HTTP routes, authorization, input validation, static assets
  auth.mjs                 Scrypt passwords, hashed sessions, rate limits
  database.mjs             SQLite persistence and atomic learning updates
  agents/definitions.mjs   Core learning agents and the combined agent registry
  agents/language-agents.mjs Translation, voice, pronunciation, writing, document, culture agents
  agents/tool-workflows.mjs Coordinated language tools and translation-to-learning
  agents/orchestrator.mjs  Workflow delegation, context sharing, trace recording
  ai/providers.mjs         Provider-independent structured AI service
  ai/speech.mjs            Transcription and pronunciation adapters
  ai/translation.mjs       Optional Azure Translator adapter
  ai/ocr.mjs               Real asynchronous OCR adapter
  tools/                  Upload validation, document parsing, safe public web text
  learning/                Spaced repetition engine
public/                    Responsive interface, microphone capture, static preview
tests/                     Workflow, provider, speech, security and persistence checks
```

## Verification

```powershell
npm run check
npm test
```

Tests use explicitly named test providers, text fixtures, synthetic audio, and mocked upstream HTTP responses. They verify every tool contract, coordination, persisted context, atomic failures, quiz scoring, user/language isolation, review scheduling, native voice selection, OCR polling, DOCX/text extraction, safe web retrieval, translation evidence, provider requests, speech capabilities, authentication, profiles, search, and preferences. Optional browser verification in `scripts/browser-smoke.mjs` uses a local Chromium DevTools session and a separate in-memory account server. Live AI/OCR/speech quality and actual microphone/camera hardware require credentials and device testing; the automated tests do not claim to verify those external services.

## Deployment and operating limits

This implementation is a single Node server with SQLite, suitable for local use and a single server deployment. Node 24's built-in SQLite API emits an experimental warning. Store the `data/` directory on persistent storage and back it up; WAL sidecar files belong to the same database. Run one process per database file. On restart, interrupted agent runs are marked failed. Graceful shutdown gives requests five seconds before exiting.

For internet deployment, use an HTTPS reverse proxy, set `APP_ORIGIN` to the public origin, set `COOKIE_SECURE=true`, and set `HOST=0.0.0.0` on a protected backend network. Do not expose the raw development server directly. Authentication uses salted scrypt hashes and HttpOnly, SameSite cookies; session tokens are hashed in the database. Writes validate browser origin, all SQL values are bound, AI content is rendered as text, and credentials stay server-side.

Sessions expire after 30 days. Email verification, password recovery, account deletion, distributed rate limiting, durable background jobs, streaming responses, and a multi-instance database adapter are not implemented. Network calls are cancellable and have bounded timeouts; an active workflow per learner/language prevents conflicting updates. A disconnected request cancels learning execution, although a provider may still bill a request already received. Provider retention rules apply to submitted learner context and audio. To scale across processes, replace the SQLite repository and in-memory rate limiter with shared services and use a durable job queue. Preserve the transaction and ownership guarantees.
