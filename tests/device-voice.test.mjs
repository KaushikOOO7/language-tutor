import test from 'node:test';
import assert from 'node:assert/strict';
import { speak } from '../public/audio.js';

test('text-to-speech selects a Kannada device voice and reports missing languages without an English fallback',t => {
  const priorWindow = globalThis.window;const priorSpeech = globalThis.speechSynthesis;const priorUtterance = globalThis.SpeechSynthesisUtterance;
  let spoken;
  const synthesis = {cancel:() => {},getVoices:() => [{lang:'kn-IN',name:'Kannada voice'}],speak:utterance => {spoken = utterance;}};
  globalThis.window = {speechSynthesis:synthesis};globalThis.speechSynthesis = synthesis;
  globalThis.SpeechSynthesisUtterance = class {constructor(text) {this.text = text;}};
  t.after(() => {globalThis.window = priorWindow;globalThis.speechSynthesis = priorSpeech;globalThis.SpeechSynthesisUtterance = priorUtterance;});
  speak('ನಮಸ್ಕಾರ','Kannada');assert.equal(spoken.lang,'kn-IN');assert.equal(spoken.text,'ನಮಸ್ಕಾರ');
  assert.throws(() => speak('hello','French'),/Install a French voice/);
  assert.throws(() => speak('hello','Unsupported'),/supported language/);
});
