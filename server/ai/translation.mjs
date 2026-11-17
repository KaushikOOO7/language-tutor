import { AppError } from '../errors.mjs';
import { languageMap, languageCatalog } from '../../public/languages.js';

export class TranslationService {
  constructor(settings = { provider: 'llm' }, fetchImpl = fetch) { this.settings = settings; this.fetch = fetchImpl; this.catalogue = null; }
  status() {
    const configured = this.settings.provider === 'llm' || (this.settings.provider === 'azure' && Boolean(this.settings.apiKey));
    return { provider: this.settings.provider, configured, needsAI: true, reason: configured ? null : 'Configure the Azure Translator key or choose TRANSLATION_PROVIDER=llm.' };
  }
  async request(path, body, signal, authenticated = true) {
    const combined = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
    try {
      const response = await this.fetch(`${this.settings.baseUrl}${path}`, {
        method: body ? 'POST' : 'GET', signal: combined,
        headers: { 'Content-Type': 'application/json', ...(authenticated ? { 'Ocp-Apim-Subscription-Key': this.settings.apiKey,
          ...(this.settings.region ? { 'Ocp-Apim-Subscription-Region': this.settings.region } : {}) } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new AppError(response.status === 400 ? 422 : 502, response.status === 400 ? 'TRANSLATION_UNSUPPORTED' : 'TRANSLATION_PROVIDER_ERROR',
        response.status === 400 ? 'The translation provider does not support this language or script combination.' : 'The translation provider rejected the request. Check its credentials and region.');
      const raw = await response.text();
      if (raw.length > 1_000_000) throw new Error('Oversized response');
      return JSON.parse(raw);
    } catch (error) {
      if (combined.aborted) throw new AppError(504, 'TRANSLATION_TIMEOUT', 'The translation request timed out.');
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'TRANSLATION_UNREACHABLE', 'The translation provider could not be reached or returned an unreadable response.');
    }
  }
  async supportedLanguages(signal) {
    if (this.catalogue && this.catalogue.expires > Date.now()) return this.catalogue.value;
    const value = await this.request('/languages?api-version=3.0&scope=translation,transliteration', null, signal, false);
    if (!value.translation || typeof value.translation !== 'object') throw new AppError(502, 'INVALID_TRANSLATION_OUTPUT', 'The provider returned an invalid language catalogue.');
    this.catalogue = { value, expires: Date.now() + 3600000 }; return value;
  }
  async translate({ text, sourceLanguage, targetLanguage, signal }) {
    if (this.settings.provider === 'llm') return null; // Translation Agent performs the actual LLM translation.
    if (!this.status().configured) throw new AppError(503, 'TRANSLATION_NOT_CONFIGURED', this.status().reason);
    const source = sourceLanguage === 'Auto' ? null : languageMap[sourceLanguage]?.translationCode;
    const target = languageMap[targetLanguage]?.translationCode;
    const supported = await this.supportedLanguages(signal);
    if (!target || !Object.hasOwn(supported.translation, target) || (source && !Object.hasOwn(supported.translation, source))) {
      throw new AppError(422, 'TRANSLATION_LANGUAGE_UNSUPPORTED', 'Azure Translator does not currently support this language pair. Choose another language or configure an LLM translation provider.');
    }
    const result = await this.request(`/translate?api-version=3.0&to=${encodeURIComponent(target)}${source ? `&from=${encodeURIComponent(source)}` : ''}`, [{ Text: text }], signal);
    const translatedText = result[0]?.translations?.[0]?.text;
    if (typeof translatedText !== 'string' || !translatedText.trim() || translatedText.length > 30000) throw new AppError(502, 'INVALID_TRANSLATION_OUTPUT', 'The provider did not return a valid translation.');
    return { translatedText, detectedCode: result[0]?.detectedLanguage?.language || source, provider: 'azure' };
  }
  async detect({ text, signal }) {
    if (this.settings.provider === 'llm') return null;
    if (!this.status().configured) throw new AppError(503, 'TRANSLATION_NOT_CONFIGURED', this.status().reason);
    const result = (await this.request('/detect?api-version=3.0', [{ Text: text }], signal))[0];
    if (!result || typeof result.language !== 'string' || typeof result.score !== 'number' || result.score < 0 || result.score > 1) throw new AppError(502, 'INVALID_TRANSLATION_OUTPUT', 'Language detection returned invalid data.');
    return { language: languageCatalog.find(item => item.translationCode === result.language || item.code === result.language)?.name || 'Unknown', code: result.language, confidence: result.score, provider: 'azure' };
  }
  async transliterate({ text, sourceLanguage, fromScript, toScript, signal }) {
    if (this.settings.provider === 'llm') return null;
    if (!this.status().configured) throw new AppError(503, 'TRANSLATION_NOT_CONFIGURED', this.status().reason);
    const code = languageMap[sourceLanguage]?.translationCode;
    const result = (await this.request(`/transliterate?api-version=3.0&language=${encodeURIComponent(code)}&fromScript=${encodeURIComponent(fromScript)}&toScript=${encodeURIComponent(toScript)}`, [{ Text: text }], signal))[0];
    if (typeof result?.text !== 'string' || !result.text.trim() || result.text.length > 16000 || result.script !== toScript) throw new AppError(502, 'INVALID_TRANSLATION_OUTPUT', 'The provider returned invalid transliteration data.');
    return { text: result.text, script: result.script, provider: 'azure' };
  }
}
