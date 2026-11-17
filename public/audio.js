import { languageMap } from './languages.js';
// Record actual microphone audio and convert it to mono 16 kHz PCM WAV.
export class Recorder {
  constructor() { this.chunks = []; this.running = false; }
  async start(onTime) {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone recording needs localhost or HTTPS and a supported browser.');
    this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true }, video: false });
    try {
      this.context = new AudioContext();
      await this.context.resume();
      this.source = this.context.createMediaStreamSource(this.stream);
      this.processor = this.context.createScriptProcessor(4096, 1, 1);
      this.processor.onaudioprocess = (event) => { if (this.running) this.chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
      this.source.connect(this.processor); this.processor.connect(this.context.destination);
      this.chunks = []; this.running = true; this.started = Date.now(); this.sampleRate = this.context.sampleRate;
      this.timer = setInterval(() => onTime(Math.min(60, Math.floor((Date.now() - this.started) / 1000))), 250);
    } catch (error) { await this.cancel(); throw error; }
  }
  async stop() {
    this.running = false;
    const chunks = this.chunks;
    await this.cancel();
    const length = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const samples = new Float32Array(length);
    let offset = 0;
    for (const chunk of chunks) { samples.set(chunk, offset); offset += chunk.length; }
    const ratio = this.sampleRate / 16000;
    const count = Math.min(960000, Math.floor(length / ratio));
    if (count < 16000) throw new Error('Record at least one second of speech before stopping.');
    const buffer = new ArrayBuffer(44 + count * 2); const view = new DataView(buffer);
    const write = (at, text) => [...text].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
    write(0, 'RIFF'); view.setUint32(4, 36 + count * 2, true); write(8, 'WAVE'); write(12, 'fmt ');
    view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true); view.setUint32(24, 16000, true);
    view.setUint32(28, 32000, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true); write(36, 'data'); view.setUint32(40, count * 2, true);
    for (let i = 0; i < count; i++) {
      const start = Math.floor(i * ratio); const end = Math.min(length, Math.max(start + 1, Math.floor((i + 1) * ratio)));
      let sum = 0; for (let j = start; j < end; j++) sum += samples[j];
      const value = Math.max(-1, Math.min(1, sum / (end - start)));
      view.setInt16(44 + i * 2, value < 0 ? value * 32768 : value * 32767, true);
    }
    const bytes = new Uint8Array(buffer); let binary = '';
    for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
    return btoa(binary);
  }
  async cancel() {
    this.running = false; clearInterval(this.timer);
    this.source?.disconnect(); this.processor?.disconnect();
    this.stream?.getTracks().forEach(track => track.stop());
    if (this.context && this.context.state !== 'closed') await this.context.close();
  }
}

export function speak(text, language, accent) {
  if (!('speechSynthesis' in window)) throw new Error('Your browser does not support a device voice.');
  speechSynthesis.cancel();
  if (!languageMap[language]) throw new Error('Choose a supported language for the device voice.');
  const utterance = new SpeechSynthesisUtterance(text); utterance.lang = accent || languageMap[language].locale; utterance.rate = 0.85;
  const voices = speechSynthesis.getVoices();
  const voice = voices.find(item => item.lang.toLowerCase().replace('_','-') === utterance.lang.toLowerCase())
    || voices.find(item => item.lang.toLowerCase().split(/[-_]/)[0] === utterance.lang.split('-')[0]);
  if (!voice) throw new Error(`Install a ${language} voice in your device settings to listen to this activity.`);
  utterance.voice = voice; speechSynthesis.speak(utterance);
}
