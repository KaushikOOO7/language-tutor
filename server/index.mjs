import { config } from './config.mjs';
import { Repository } from './database.mjs';
import { AIService } from './ai/providers.mjs';
import { SpeechService } from './ai/speech.mjs';
import { AgentOrchestrator } from './agents/orchestrator.mjs';
import { createApplication } from './app.mjs';
import { TranslationService } from './ai/translation.mjs';
import { OCRService } from './ai/ocr.mjs';

const repository = new Repository(config.databasePath);
repository.recoverInterruptedRuns();
const ai = new AIService(config.ai);
const speech = new SpeechService(config.speech);
const translation = new TranslationService(config.translation);
const ocr = new OCRService(config.ocr);
const orchestrator = new AgentOrchestrator({ repository, ai, speech, translation, ocr });
const server = createApplication({ config, repository, ai, speech, translation, ocr, orchestrator });
server.listen(config.port, config.host, () => {
  console.log(`Language Tutor Bot: http://${config.host}:${config.port}`);
  console.log(`AI agents: ${ai.status().configured ? `configured (${config.ai.provider})` : 'not configured — the product preview contains labeled sample data'}`);
  console.log(`Speech analysis: ${speech.status().configured ? `configured (${config.speech.provider})` : 'not configured'}`);
});
let stopping = false;
function stop() {
  if (stopping) return; stopping = true;
  server.close(() => { repository.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
