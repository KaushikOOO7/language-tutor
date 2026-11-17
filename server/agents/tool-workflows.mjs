import { randomUUID } from 'node:crypto';
import { AppError } from '../errors.mjs';
import { languageMap } from '../../public/languages.js';
import { toolCatalog } from '../../public/catalog.js';
import { extractLocalDocument, splitDocument, htmlToText } from '../tools/documents.mjs';
import { fetchPublicText } from '../tools/web-text.mjs';

export function prepareToolContext(repo, userId, request) {
  if (!toolCatalog.some(tool => tool.id === request.tool)) throw new AppError(400, 'UNKNOWN_TOOL', 'This language tool is not supported.');
  if (request.tool !== 'live-conversation') return null;
  if (!request.conversationId) return { id:randomUUID(), languageA:request.speaker === 'B' ? request.targetLanguage : request.sourceLanguage,
    languageB:request.speaker === 'B' ? request.sourceLanguage : request.targetLanguage, turns:[] };
  const session = repo.communication(userId, request.conversationId);
  const source = request.speaker === 'B' ? session.languageB : session.languageA;
  const target = request.speaker === 'B' ? session.languageA : session.languageB;
  if (request.sourceLanguage !== source || request.targetLanguage !== target) throw new AppError(400, 'CONVERSATION_LANGUAGE_MISMATCH', 'Use the languages selected for this conversation, or start a new conversation.');
  return session;
}

export async function executeLanguageTool({ request, profile, invoke, group, serviceStep, services, signal, outputs, session, aiConfigured }) {
  const { tool, sourceLanguage, targetLanguage } = request;
  let text = request.text || ''; let extraction, speechEvidence, result;
  const externalTranslation = (method, args) => services.translation.status().provider === 'azure'
    ? serviceStep('translationService', () => services.translation[method]({ ...args, signal })) : Promise.resolve(null);
  if (request.audio) {
    speechEvidence = await serviceStep('speechService', () => services.speech.transcribe({ audio:request.audio, locale:languageMap[sourceLanguage].locale, signal }));
    text = speechEvidence.transcript;
  }
  if (request.file) {
    extraction = await serviceStep(request.format.needsOCR ? 'ocrService' : 'documentParser', () => request.format.needsOCR
      ? services.ocr.extract({ bytes:request.file, mimeType:request.format.mimeType, signal }) : extractLocalDocument(request.file, request.format));
    text = extraction.text;
  }
  if (request.url) { extraction = await serviceStep('websiteReader', () => fetchPublicText(request.url, signal)); text = extraction.text; }
  if (request.isHTML && !request.url) text = htmlToText(text);
  if (!text.trim()) throw new AppError(422, 'NO_TEXT_FOUND', 'No readable text was available for this tool.');
  const task = { operation:tool, text, sourceLanguage, targetLanguage, tone:request.tone, purpose:request.purpose,
    dialect:profile.dialect, accent:profile.accent, fromScript:request.fromScript, toScript:request.toScript };
  if (tool === 'stt') {
    result = { kind:'transcript', text, sourceLanguage, targetLanguage:sourceLanguage, notes:[speechEvidence.limitation] };
    if (aiConfigured) await invoke('voice', { ...task, actualTranscript:text, instruction:'Explain the supplied transcript without inventing a translation.' });
  } else if (tool === 'grammar-check') {
    await invoke('grammar', { ...task, learnerText:text });
    await invoke('writing', { ...task, operation:'writing', purpose:'Apply only the evidenced grammar corrections and preserve meaning.' }, { grammar:outputs.grammar });
    result = { kind:'writing', text:outputs.writing.revisedText, explanation:outputs.grammar.explanation, corrections:outputs.grammar.corrections,
      changes:outputs.writing.changes, notes:[], sourceLanguage:targetLanguage, targetLanguage };
  } else if (['writing','paraphrase','summarize'].includes(tool)) {
    await invoke('writing', task);
    if (tool !== 'summarize') await invoke('grammar', { ...task, learnerText:text }, { writing:outputs.writing });
    result = { kind:'writing', text:outputs.writing.revisedText, explanation:outputs.writing.explanation, changes:outputs.writing.changes,
      alternatives:outputs.writing.alternatives, notes:[], sourceLanguage, targetLanguage };
  } else if (tool === 'pronunciation') {
    await invoke('pronunciation', task);
    result = { kind:'pronunciation', text, explanation:outputs.pronunciation.guidance, phonetic:outputs.pronunciation.phonetic,
      syllables:outputs.pronunciation.syllables, practicePhrase:outputs.pronunciation.practicePhrase, notes:outputs.pronunciation.cautions,
      sourceLanguage:targetLanguage, targetLanguage };
  } else if (tool === 'detect') {
    const external = await externalTranslation('detect', { text });
    await invoke('translation', task, external ? { languageDetection:external } : {});
    result = { kind:'detection', text:external?.language || outputs.translation.detectedLanguage, confidence:external?.confidence ?? outputs.translation.confidence,
      code:external?.code || null, explanation:outputs.translation.explanation, notes:outputs.translation.notes,
      confidenceSource:external ? 'Azure detection score' : 'Language model estimate', sourceLanguage, targetLanguage };
  } else if (tool === 'transliterate') {
    const external = await externalTranslation('transliterate', task);
    await invoke('translation', task, external ? { transliteration:external } : {});
    result = { kind:'transliteration', text:external?.text || outputs.translation.translatedText, explanation:outputs.translation.explanation,
      fromScript:request.fromScript, toScript:request.toScript, notes:outputs.translation.notes, sourceLanguage, targetLanguage:sourceLanguage };
  } else if (tool === 'dictionary') {
    await invoke('translation', task);
    await invoke('culture', task, { dictionary:outputs.translation });
    result = { kind:'dictionary', text, explanation:outputs.translation.explanation, definitions:outputs.translation.definitions,
      synonyms:outputs.translation.synonyms, antonyms:outputs.translation.antonyms, notes:outputs.translation.notes, sourceLanguage:targetLanguage, targetLanguage };
  } else {
    if (['documents','web-translate'].includes(tool)) {
      const parts = splitDocument(text); const translated = []; const glossary = []; const summaries = []; const warnings = [];
      for (const [index, part] of parts.entries()) {
        const external = await externalTranslation('translate', { text:part, sourceLanguage, targetLanguage });
        const output = await invoke('document', { ...task, text:part, section:index + 1, sections:parts.length }, { glossary:glossary.slice(-20), ...(external ? { actualTranslation:external } : {}) });
        if (external && output.translatedText !== external.translatedText) throw new AppError(502, 'INCONSISTENT_TRANSLATION', 'The document agent changed the supplied translation evidence. Please retry.');
        translated.push(output.translatedText); summaries.push(output.summary); glossary.push(...output.glossary); warnings.push(...output.warnings);
      }
      result = { kind:'document', text:translated.join('\n'), explanation:summaries.join('\n'), glossary:glossary.slice(0,40), notes:[...new Set(warnings)].slice(0,10),
        filename:request.filename || 'web-page.txt', sections:parts.length, sourceLanguage, targetLanguage };
      if (result.text.length > 100000) throw new AppError(413, 'TRANSLATION_TOO_LONG', 'The translation is too large to save in one request.');
    } else {
      const parts = splitDocument(text,2500);const translated = [];const explanations = [];const notes = [];const detected = [];
      for (const [index,part] of parts.entries()) {
        const external = await externalTranslation('translate',{text:part,sourceLanguage,targetLanguage});
        const previous = outputs.translation;
        const output = await invoke('translation',{...task,text:part,section:index + 1,sections:parts.length},
          {...(external ? {actualTranslation:external} : {}),...(previous ? {previousSection:previous.translatedText} : {})});
        if (external && output.translatedText !== external.translatedText) throw new AppError(502,'INCONSISTENT_TRANSLATION','The agent changed the supplied translation evidence. Please retry.');
        translated.push(output.translatedText);explanations.push(output.explanation);notes.push(...output.notes);detected.push(output.detectedLanguage);
      }
      result = {kind:'translation',text:translated.join('\n'),explanation:explanations.join('\n').slice(0,8000),
        detectedLanguage:detected.every(language => language === detected[0]) ? detected[0] : 'Unknown',notes:[...new Set(notes)].slice(0,10),sourceLanguage,targetLanguage};
    }
    await invoke('culture', { ...task, text:text.slice(0,6000), translatedText:result.text.slice(0,6000) });
    if (['voice-translate','live-conversation'].includes(tool)) await invoke('voice', { ...task, actualTranscript:text, translatedText:result.text,
      previousTurns:session?.turns || [], speechEvidence }, { translation:outputs.translation, culture:outputs.culture });
  }
  result.extractedText = extraction ? text : undefined;
  result.extractionSource = extraction?.source;
  result.sourceUrl = extraction?.sourceUrl;
  result.transcript = speechEvidence?.transcript;
  result.speechLimitation = speechEvidence?.limitation;
  if (outputs.culture) result.culturalContext = outputs.culture.explanation;
  if (outputs.voice) result.conversationGuidance = outputs.voice.explanation;
  const learn = request.learn && aiConfigured && !['detect','transliterate'].includes(tool);
  if (learn) {
    const learningText = result.kind === 'dictionary' ? text : result.text.slice(0,5000);
    await group(
      () => outputs.pronunciation ? Promise.resolve() : invoke('pronunciation', { operation:'pronunciation', text:learningText.slice(0,600), targetLanguage, accent:profile.accent }),
      () => outputs.grammar ? Promise.resolve() : invoke('grammar', { learnerText:learningText, instruction:'Explain the useful grammar in this generated or translated material. Do not invent learner mistakes.' }),
      () => invoke('vocabulary', { text:learningText, sourceLanguage:targetLanguage, translationLanguage:profile.nativeLanguage,
        instruction:'Save useful target-language words from the material, with native-language translations.' }),
    );
    await invoke('content', { kind:'quiz', focus:`Practice the vocabulary and grammar from this ${tool} result.`, material:learningText },
      { grammar:outputs.grammar, vocabulary:outputs.vocabulary, pronunciation:outputs.pronunciation });
    await invoke('learningPath', { instruction:'Update the learning plan using this new learning material. No exercise has been completed yet.' }, { vocabulary:outputs.vocabulary, grammar:outputs.grammar, content:outputs.content });
    await invoke('progress', { instruction:'Recommend how to practice this material using real history. Tool output is not proof of improved proficiency.' }, { learningPath:outputs.learningPath, vocabulary:outputs.vocabulary });
    result.practicePhrase = outputs.pronunciation.practicePhrase;
    result.phonetic = outputs.pronunciation.phonetic;
    result.pronunciationGuidance = outputs.pronunciation.guidance;
    result.notes.push(...outputs.pronunciation.cautions);
    if (result.kind === 'document') result.notes.push('The saved learning exercise uses a short excerpt of this document.');
  }
  let communication;
  if (session) {
    const turn = { speaker:request.speaker, sourceLanguage, targetLanguage, transcript:text, translation:result.text, explanation:outputs.voice?.explanation || result.explanation };
    communication = { ...session, turn };
    result.conversationId = session.id; result.turns = [...session.turns,turn].slice(-20);
  }
  return { result, input:{ text, sourceLanguage, targetLanguage, filename:request.filename, sourceUrl:extraction?.sourceUrl, learn },
    activity:learn ? outputs.content : undefined, enrollProfile:learn ? profile : undefined, communication };
}
