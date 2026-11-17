import { AppError } from '../errors.mjs';
import { languageMap, scriptNames } from '../../public/languages.js';
import { toolCatalog } from '../../public/catalog.js';
import { validateWav } from '../ai/speech.mjs';
import { validateUpload } from './documents.mjs';

export function requiredText(value, label, max = 6000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new AppError(400, 'INVALID_TOOL_INPUT', `${label} must contain 1 to ${max} characters.`);
  return value.trim();
}
const language = (value, allowAuto = false) => {
  if ((allowAuto && value === 'Auto') || Object.hasOwn(languageMap, value)) return value;
  throw new AppError(422, 'LANGUAGE_UNSUPPORTED', 'Choose a language from the language selector. Provider capabilities vary by language.');
};
function base64(value, label, max) {
  if (typeof value !== 'string' || !value.length || value.length > max || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new AppError(400, 'INVALID_UPLOAD', `${label} must contain valid base64 data within the upload limit.`);
  return Buffer.from(value, 'base64');
}
export function toolInput(id, body, profile) {
  const tool = toolCatalog.find(tool => tool.id === id);
  if (!tool || id === 'tts') throw new AppError(400, 'UNKNOWN_TOOL', 'Choose a supported server tool. Text-to-speech uses the voice installed on your device.');
  const targetLanguage = language(body.targetLanguage || profile.language);
  const sourceLanguage = language(body.sourceLanguage || (['word','script'].includes(tool.input) ? targetLanguage : 'Auto'), !['audio','script'].includes(tool.input));
  const input = { tool:id, sourceLanguage, targetLanguage, learn: body.learn === true,
    durationSeconds: Math.min(3600, Math.max(0, Number.isFinite(body.durationSeconds) ? Math.round(body.durationSeconds) : 0)) };
  if (['text','word','script','turn'].includes(tool.input) && !(tool.input === 'turn' && body.audioBase64)) input.text = requiredText(body.text, 'Text', tool.input === 'word' ? 300 : 6000);
  if (tool.input === 'audio' || (tool.input === 'turn' && body.audioBase64)) {
    input.audio = base64(body.audioBase64, 'Audio', 2600000); validateWav(input.audio);
    input.sourceLanguage = language(body.sourceLanguage); // Explicit locale improves speech recognition.
  }
  if (['image','document'].includes(tool.input)) {
    input.filename = requiredText(body.filename, 'Filename', 180).replace(/[\\/\x00-\x1f]/g, '_');
    input.file = base64(body.fileBase64, 'File', 10667000);
    input.format = validateUpload(input.file, input.filename, tool.input === 'image');
  }
  if (tool.input === 'web') {
    if (body.url) input.url = requiredText(body.url, 'Website URL', 2048);
    else input.text = requiredText(body.text, 'Pasted content', 24000);
    input.isHTML = body.isHTML === true;
  }
  if (tool.input === 'script') {
    if (!Object.hasOwn(scriptNames, body.fromScript) || !Object.hasOwn(scriptNames, body.toScript) || body.fromScript === body.toScript) throw new AppError(400, 'INVALID_SCRIPT', 'Choose two different supported scripts.');
    const scripts = new Set([...languageMap[sourceLanguage].scripts, 'Latn']);
    if (!scripts.has(body.fromScript) || !scripts.has(body.toScript)) throw new AppError(422, 'SCRIPT_UNSUPPORTED', 'Choose a native script or Latin transliteration for this language.');
    input.fromScript = body.fromScript; input.toScript = body.toScript;
    input.targetLanguage = sourceLanguage;
  }
  if (id === 'stt') input.targetLanguage = sourceLanguage;
  if (['writing','paraphrase','summarize'].includes(id)) {
    input.tone = ['natural','formal','friendly','professional','concise'].includes(body.tone) ? body.tone : 'natural';
    input.purpose = body.purpose ? requiredText(body.purpose, 'Writing purpose', 300) : 'Clear communication';
  }
  if (id === 'live-conversation') {
    if (sourceLanguage === 'Auto' || sourceLanguage === targetLanguage) throw new AppError(400, 'INVALID_LANGUAGE_PAIR', 'Choose two different languages for conversation translation.');
    if (body.conversationId) input.conversationId = requiredText(body.conversationId, 'Conversation ID', 100);
    input.speaker = ['A','B'].includes(body.speaker) ? body.speaker : 'A';
  }
  return input;
}
