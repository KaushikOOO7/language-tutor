import { str, num, arr, obj, enumeration } from '../ai/schema.mjs';
import { languageCatalog, scriptNames } from '../../public/languages.js';

const memory = arr(str(350), 8);
const detectedLanguage = enumeration([...languageCatalog.map(item => item.name), 'Unknown']);
export const languageAgents = {
  translation: {
    name:'Translation Agent', description:'Translate faithfully and explain the meaning.',
    instructions:'Translate the supplied text into the requested target language. Preserve names, numbers, tone, meaning and paragraph breaks. When actual external translation evidence is supplied, return its translatedText exactly and explain it; never silently replace it. For language detection return Unknown if the sample is insufficient; confidence is an estimate, never a guarantee. For transliteration convert script only, without changing language or meaning. Explicitly explain uncertainty and low-resource language limitations. For dictionary provide real lexical information, and empty synonym/antonym arrays when none apply. Do not invent citations. Use the requested operation to fill result fields; for unused fields give a short relevant description and empty arrays.',
    schema:obj({ translatedText:str(30000), explanation:str(3500), detectedLanguage, confidence:num(0,1),
      definitions:arr(obj({ partOfSpeech:str(80), definition:str(700), example:str(600) }),5),
      synonyms:arr(str(150),8), antonyms:arr(str(150),8), notes:arr(str(700),5), memory }),
  },
  voice: {
    name:'Voice and Conversation Agent', description:'Help people communicate across languages.',
    instructions:'Use only the actual supplied transcript or typed turn and translation. Explain a natural conversational reply or clarification. Use the saved turn history for continuity. Never invent speech recognition, speaker identity, acoustic measurements or an unheard response. These are turn-based conversations; do not claim continuous simultaneous interpretation.',
    schema:obj({ explanation:str(2500), suggestedReply:str(1500), clarification:str(1000), memory }),
  },
  pronunciation: {
    name:'Pronunciation Coach Agent', description:'Pronunciation guidance, syllables, and useful drills.',
    instructions:'Give pronunciation guidance for the requested word or translated phrase. Provide phonetic guidance, syllable breakdown and a short practice phrase. Use the selected accent when practical. A phonetic transcription is a language model estimate, not an audio measurement. If supplied actual pronunciation scores exist, base feedback on them. Never infer pronunciation accuracy or fluency from text or invent an audio file. Include a caution for uncertain IPA or low-resource languages.',
    schema:obj({ phonetic:str(1200), syllables:arr(str(200),30), guidance:str(3000), practicePhrase:str(600), cautions:arr(str(600),4), memory }),
  },
  writing: {
    name:'Writing Assistant Agent', description:'Improve writing, paraphrase, and summarize.',
    instructions:'Perform the requested writing, paraphrasing or summarizing operation in the target language. Preserve the original facts and meaning. Follow the requested tone and purpose. Explain concrete changes. For summary, do not add facts absent from the source. Provide 1 to 3 useful alternative phrasings for writing/paraphrasing; none are needed for summaries. Do not invent citations or references.',
    schema:obj({ revisedText:str(16000), explanation:str(3000), changes:arr(str(700),8), alternatives:arr(str(3000),3), memory }),
  },
  document: {
    name:'Document Translation Agent', description:'Translate extracted document sections consistently.',
    instructions:'Translate the supplied extracted document section into the requested target language. Preserve all factual content, headings, numbers, names, and paragraph breaks. Use the previous section glossary for consistency. Actual external translatedText must be returned exactly when supplied. Do not invent illegible OCR content. State uncertainty when source text is garbled. Output plain translated text; do not claim to preserve PDF layout, images, signatures or original formatting. The summary describes this section only.',
    schema:obj({ translatedText:str(14000), summary:str(2000), glossary:arr(obj({ source:str(150), target:str(250) }),10), warnings:arr(str(700),5), memory }),
  },
  culture: {
    name:'Cultural Context Agent', description:'Explain idioms, regional usage, and polite communication.',
    instructions:'Explain relevant cultural meaning, idioms, register and regional usage in the supplied learning material. Distinguish literal and figurative meanings. Respect the requested dialect or regional context while avoiding stereotypes. If the text has no idioms or regional features, return empty examples instead of inventing them. Explain uncertainty about regional expressions.',
    schema:obj({ explanation:str(3000), expressions:arr(obj({ phrase:str(300), meaning:str(700), usage:str(700) }),5), notes:arr(str(600),4), memory }),
  },
};
