import { AppError } from '../errors.mjs';

export function validateWav(audio) {
  if (audio.length < 44 || audio.toString('ascii', 0, 4) !== 'RIFF' || audio.toString('ascii', 8, 12) !== 'WAVE') {
    throw new AppError(400, 'INVALID_AUDIO', 'Upload a PCM WAV recording.');
  }
  let format, data;
  for (let offset = 12; offset + 8 <= audio.length;) {
    const id = audio.toString('ascii', offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    if (offset + 8 + size > audio.length) throw new AppError(400, 'INVALID_AUDIO', 'The WAV recording is incomplete.');
    if (id === 'fmt ' && size >= 16) format = { encoding: audio.readUInt16LE(offset + 8), channels: audio.readUInt16LE(offset + 10), rate: audio.readUInt32LE(offset + 12), bits: audio.readUInt16LE(offset + 22) };
    if (id === 'data') data = size;
    offset += 8 + size + size % 2;
  }
  if (!format || format.encoding !== 1 || format.channels !== 1 || format.rate !== 16000 || format.bits !== 16 || !data || data % 2) {
    throw new AppError(400, 'INVALID_AUDIO', 'Speech analysis needs a mono, 16-bit, 16 kHz PCM WAV recording.');
  }
  const durationSeconds = data / 32000;
  if (durationSeconds < 1 || durationSeconds > 60) throw new AppError(400, 'INVALID_AUDIO', 'Record between 1 and 60 seconds.');
  return { durationSeconds };
}

export class SpeechService {
  constructor(settings, fetchImpl = fetch) { this.settings = settings; this.fetch = fetchImpl; }
  status() {
    const configured = Boolean(this.settings.apiKey && ((this.settings.provider === 'azure' && /^[a-z0-9-]+$/.test(this.settings.region))
      || (this.settings.provider === 'openai-compatible' && this.settings.model)));
    return { configured, provider: this.settings.provider, pronunciation: configured && this.settings.provider === 'azure',
      pronunciationLocales: this.settings.pronunciationLocales || ['en-US','en-GB','es-ES','fr-FR','de-DE','it-IT','pt-BR','ja-JP','ko-KR','zh-CN','hi-IN'],
      reason: configured ? null : 'Configure a speech provider on the server to analyze recordings.' };
  }
  async analyze({ audio, locale, referenceText, signal }) {
    if (!this.status().configured) throw new AppError(503, 'SPEECH_NOT_CONFIGURED', this.status().reason);
    if (this.settings.provider === 'azure' && !this.status().pronunciationLocales.includes(locale)) {
      throw new AppError(422, 'PRONUNCIATION_LANGUAGE_UNSUPPORTED', 'Pronunciation assessment is not enabled for this locale. Use voice transcription or a supported pronunciation locale.');
    }
    const { durationSeconds } = validateWav(audio);
    const combined = signal ? AbortSignal.any([AbortSignal.timeout(45000), signal]) : AbortSignal.timeout(45000);
    try {
      let response;
      if (this.settings.provider === 'azure') {
        const assessment = Buffer.from(JSON.stringify({ ReferenceText: referenceText, GradingSystem: 'HundredMark', Granularity: 'Phoneme', Dimension: 'Comprehensive', EnableMiscue: true })).toString('base64');
        response = await this.fetch(`https://${this.settings.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(locale)}&format=detailed`, {
          method: 'POST', signal: combined, headers: { 'Ocp-Apim-Subscription-Key': this.settings.apiKey, 'Content-Type': 'audio/wav; codecs=audio/pcm; samplerate=16000', 'Pronunciation-Assessment': assessment }, body: audio,
        });
      } else {
        const body = new FormData();
        body.append('file', new Blob([audio], { type: 'audio/wav' }), 'practice.wav');
        body.append('model', this.settings.model); body.append('language', locale.split('-')[0]);
        response = await this.fetch(`${this.settings.baseUrl}/audio/transcriptions`, { method: 'POST', signal: combined, headers: { Authorization: `Bearer ${this.settings.apiKey}` }, body });
      }
      if (!response.ok) throw new AppError(502, 'SPEECH_PROVIDER_ERROR', 'The speech provider rejected the recording. Check its credentials, region, and supported language.');
      const raw = await response.text();
      if (raw.length > 200000) throw new AppError(502, 'INVALID_SPEECH_OUTPUT', 'The speech provider response was too large.');
      const result = JSON.parse(raw);
      if (this.settings.provider !== 'azure') {
        if (typeof result.text !== 'string' || !result.text.trim() || result.text.length > 10000) throw new AppError(422, 'NO_SPEECH', 'No clear speech was detected. Please try another recording.');
        return { transcript: result.text, durationSeconds, pronunciation: null, source: 'transcription', limitation: 'Pronunciation and acoustic fluency were not measured. Feedback uses the transcript only.' };
      }
      const best = result.NBest?.[0];
      if (result.RecognitionStatus !== 'Success' || !best || typeof best.Display !== 'string' || !best.Display.trim() || best.Display.length > 10000) {
        throw new AppError(422, 'NO_SPEECH', 'No clear speech was detected. Please try another recording.');
      }
      const measured = best.PronunciationAssessment || best;
      const scores = { accuracy: measured.AccuracyScore, fluency: measured.FluencyScore, completeness: measured.CompletenessScore, pronunciation: measured.PronScore };
      if (Object.values(scores).some(score => typeof score !== 'number' || !Number.isFinite(score) || score < 0 || score > 100)) {
        throw new AppError(502, 'INVALID_SPEECH_OUTPUT', 'The speech service did not return valid pronunciation measurements for this language.');
      }
      const words = (best.Words || []).slice(0, 200).map(word => {
        const accuracy = word.PronunciationAssessment?.AccuracyScore ?? word.AccuracyScore;
        return { word: String(word.Word || '').slice(0, 100), accuracy: typeof accuracy === 'number' && accuracy >= 0 && accuracy <= 100 ? accuracy : null,
          error: String(word.PronunciationAssessment?.ErrorType || word.ErrorType || 'None').slice(0, 100) };
      });
      return { transcript: best.Display, durationSeconds, pronunciation: { ...scores, words }, source: 'azure-pronunciation-assessment', limitation: 'Automated read-aloud pronunciation measurements; these are not a formal proficiency exam.' };
    } catch (error) {
      if (combined.aborted) throw new AppError(504, 'SPEECH_TIMEOUT', 'The speech request timed out. Please try again.');
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'SPEECH_UNREACHABLE', 'The speech service returned an unreadable response or could not be reached.');
    }
  }
  async transcribe({ audio, locale, signal }) {
    if (!this.status().configured) throw new AppError(503, 'SPEECH_NOT_CONFIGURED', this.status().reason);
    const { durationSeconds } = validateWav(audio);
    const combined = AbortSignal.any([AbortSignal.timeout(45000), ...(signal ? [signal] : [])]);
    try {
      let response;
      if (this.settings.provider === 'azure') {
        response = await this.fetch(`https://${this.settings.region}.stt.speech.microsoft.com/speech/recognition/conversation/cognitiveservices/v1?language=${encodeURIComponent(locale)}&format=detailed`, {
          method:'POST', signal:combined, headers:{ 'Ocp-Apim-Subscription-Key':this.settings.apiKey, 'Content-Type':'audio/wav; codecs=audio/pcm; samplerate=16000' }, body:audio,
        });
      } else {
        const body = new FormData(); body.append('file', new Blob([audio], { type:'audio/wav' }), 'recording.wav');
        body.append('model', this.settings.model); body.append('language', locale.split('-')[0]);
        response = await this.fetch(`${this.settings.baseUrl}/audio/transcriptions`, { method:'POST', signal:combined, headers:{ Authorization:`Bearer ${this.settings.apiKey}` }, body });
      }
      if (!response.ok) throw new AppError(response.status === 400 ? 422 : 502, 'SPEECH_PROVIDER_ERROR', 'The speech provider rejected this recording or language. Check its supported languages and configuration.');
      const raw = await response.text(); if (raw.length > 200000) throw new Error('Oversized speech response');
      const result = JSON.parse(raw);
      const transcript = this.settings.provider === 'azure' ? result.NBest?.[0]?.Display || result.DisplayText : result.text;
      if (typeof transcript !== 'string' || !transcript.trim() || transcript.length > 10000 || (this.settings.provider === 'azure' && result.RecognitionStatus !== 'Success')) {
        throw new AppError(422, 'NO_SPEECH', 'No clear speech was detected. Try a clearer recording or another supported language.');
      }
      return { transcript, durationSeconds, pronunciation:null, source:this.settings.provider, limitation:'Transcription only. Pronunciation and acoustic fluency were not measured.' };
    } catch (error) {
      if (combined.aborted) throw new AppError(504, 'SPEECH_TIMEOUT', 'The speech request was interrupted or timed out.');
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'SPEECH_UNREACHABLE', 'Speech recognition could not be reached or returned invalid data.');
    }
  }
}
