import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { languageCatalog } from '../public/languages.js';

const envPath = resolve('.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (match && process.env[match[1]] === undefined) {
      process.env[match[1]] = match[2].replace(/^(["'])(.*)\1$/, '$2');
    }
  }
}

function endpoint(value, fallback) {
  const url = new URL(value || fallback);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('AI service endpoints must be HTTP(S) URLs without embedded credentials, queries, or fragments.');
  }
  if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    throw new Error('Remote AI endpoints must use HTTPS.');
  }
  return url.href.replace(/\/$/, '');
}

export const config = {
  host: process.env.HOST || '127.0.0.1',
  port: Number(process.env.PORT || 3000),
  databasePath: resolve(process.env.DATABASE_PATH || './data/tutor.sqlite'),
  origin: process.env.APP_ORIGIN || `http://localhost:${process.env.PORT || 3000}`,
  secureCookie: process.env.COOKIE_SECURE === 'true',
  ai: {
    provider: process.env.AI_PROVIDER || 'disabled',
    model: process.env.AI_MODEL || '',
    apiKey: process.env.AI_API_KEY || '',
    baseUrl: endpoint(process.env.AI_BASE_URL, 'https://api.openai.com/v1'),
    timeoutMs: Math.min(120000, Math.max(1000, Number(process.env.AI_TIMEOUT_MS) || 45000)),
    allowKeyless: process.env.AI_ALLOW_KEYLESS === 'true',
    maxOutputTokens:Math.min(16000,Math.max(512,Number(process.env.AI_MAX_OUTPUT_TOKENS) || 8000)),
    tokenParameter:process.env.AI_TOKEN_PARAMETER === 'max_completion_tokens' ? 'max_completion_tokens' : 'max_tokens',
  },
  speech: {
    provider: process.env.SPEECH_PROVIDER || 'disabled',
    apiKey: process.env.SPEECH_API_KEY || '',
    baseUrl: endpoint(process.env.SPEECH_BASE_URL, 'https://api.openai.com/v1'),
    model: process.env.SPEECH_MODEL || 'whisper-1',
    region: process.env.AZURE_SPEECH_REGION || '',
    pronunciationLocales: (process.env.SPEECH_PRONUNCIATION_LOCALES || 'en-US,en-GB,es-ES,fr-FR,de-DE,it-IT,pt-BR,ja-JP,ko-KR,zh-CN,hi-IN').split(',').map(value => value.trim()).filter(Boolean),
  },
  translation: {
    provider: process.env.TRANSLATION_PROVIDER || 'llm',
    apiKey: process.env.TRANSLATION_API_KEY || '',
    region: process.env.TRANSLATION_REGION || '',
    baseUrl: endpoint(process.env.TRANSLATION_BASE_URL, 'https://api.cognitive.microsofttranslator.com'),
  },
  ocr: {
    provider: process.env.OCR_PROVIDER || 'disabled', apiKey: process.env.OCR_API_KEY || '',
    baseUrl: process.env.OCR_BASE_URL ? endpoint(process.env.OCR_BASE_URL, '') : '',
  },
};

export const languages = Object.fromEntries(languageCatalog.map(language => [language.name, language.locale]));
export const levels = ['A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
export const activityKinds = ['lesson', 'quiz', 'reading', 'writing', 'listening', 'speaking', 'conversation', 'vocabulary'];
