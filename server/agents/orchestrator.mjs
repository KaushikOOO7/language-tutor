import { agents, validateAgentSemantics } from './definitions.mjs';
import { AppError, publicError } from '../errors.mjs';
import { languages } from '../config.mjs';
import { scheduleReview } from '../learning/spaced-repetition.mjs';
import { publicActivity } from '../database.mjs';
import { executeLanguageTool, prepareToolContext } from './tool-workflows.mjs';
import { TranslationService } from '../ai/translation.mjs';
import { OCRService } from '../ai/ocr.mjs';

export const workflows = {
  conversation: ['tutor', 'grammar', 'assessment', 'vocabulary', 'learningPath', 'progress'],
  createActivity: ['learningPath', 'content', 'vocabulary', 'progress'],
  assessActivity: ['assessment', 'grammar', 'vocabulary', 'learningPath', 'progress'],
  speaking: ['speaking', 'assessment', 'grammar', 'vocabulary', 'learningPath', 'progress'],
  review: ['vocabulary', 'assessment', 'learningPath', 'progress'],
  plan: ['learningPath', 'progress'],
  progress: ['learningPath', 'progress'],
  tool: ['translation','voice','pronunciation','writing','document','culture','grammar','vocabulary','content','learningPath','progress'],
};

export class AgentOrchestrator {
  constructor({ repository, ai, speech, translation = new TranslationService(), ocr = new OCRService() }) {
    this.repo = repository; this.ai = ai; this.speech = speech; this.services = { speech, translation, ocr };
  }

  async execute(userId, workflow, request, requestSignal) {
    if (!workflows[workflow]) throw new AppError(400, 'UNKNOWN_WORKFLOW', 'This learning workflow is not supported.');
    if (!this.ai.status().configured && !(workflow === 'tool' && request.tool === 'stt')) throw new AppError(503, 'AI_NOT_CONFIGURED', this.ai.status().reason);
    const activeProfile = this.repo.profile(userId);
    const language = workflow === 'tool' ? request.targetLanguage : activeProfile.language;
    if (!Object.hasOwn(languages, language)) throw new AppError(422, 'LANGUAGE_UNSUPPORTED', 'Choose a supported language profile or tool language.');
    const profile = this.repo.profile(userId, language);
    const session = workflow === 'tool' ? prepareToolContext(this.repo, userId, request) : null;
    if (workflow === 'tool' && request.audio && !this.speech.status().configured) throw new AppError(503, 'SPEECH_NOT_CONFIGURED', this.speech.status().reason);
    if (workflow === 'tool' && request.format?.needsOCR && !this.services.ocr.status().configured) throw new AppError(503, 'OCR_NOT_CONFIGURED', this.services.ocr.status().reason);
    // Resolve all owned resources before making a billable AI request.
    let activity, review, input = { ...request }, kind, score, durationSeconds = request.durationSeconds || 0;
    if (['assessActivity', 'speaking'].includes(workflow)) {
      activity = this.repo.activity(userId, language, request.activityId);
      if (activity.completedAt) throw new AppError(409, 'ALREADY_COMPLETED', 'This activity has already been completed. Generate a new one to practice again.');
      if (workflow === 'speaking' && activity.kind !== 'speaking') throw new AppError(400, 'WRONG_ACTIVITY', 'Generate a speaking exercise before submitting a recording.');
      if (workflow === 'assessActivity' && ['speaking', 'conversation', 'vocabulary'].includes(activity.kind)) {
        throw new AppError(400, 'WRONG_ACTIVITY', 'Use the matching conversation, speaking, or vocabulary workflow for this activity.');
      }
      kind = activity.kind;
      input.activity = activity.content;
      if (workflow === 'assessActivity' && activity.content.questions.length) {
        if (!Array.isArray(request.answers) || request.answers.length !== activity.content.questions.length) {
          throw new AppError(400, 'MISSING_ANSWERS', 'Answer every question before submitting.');
        }
        input.objectiveResults = activity.content.questions.map((question, index) => {
          const choice = request.answers[index];
          if (!Number.isInteger(choice) || choice < 0 || choice >= question.options.length) throw new AppError(400, 'INVALID_ANSWER', 'Select a valid answer for every question.');
          return { question: question.prompt, answer: question.options[choice], correctAnswer: question.options[question.answerIndex],
            correct: choice === question.answerIndex, explanation: question.explanation };
        });
        score = Math.round(100 * input.objectiveResults.filter(item => item.correct).length / input.objectiveResults.length);
        input.objectiveScore = score;
      } else if (workflow === 'assessActivity' && (!request.text || request.text.trim().length < 3)) {
        throw new AppError(400, 'MISSING_RESPONSE', 'Write your response before submitting.');
      }
    }
    if (workflow === 'review') {
      const word = this.repo.word(userId, language, request.wordId);
      if (Date.parse(word.due_at) > Date.now()) throw new AppError(409, 'REVIEW_NOT_DUE', 'This word is already scheduled for a future review.');
      review = scheduleReview(word, request.rating);
      input = { word: { term: word.term, translation: word.translation, example: word.example, repetitions: word.repetitions },
        selfReportedRecall: request.rating, nextReviewAt: review.dueAt };
      kind = 'vocabulary';
      score = null; // Recall ratings are not proficiency scores.
    }
    if (workflow === 'conversation') kind = 'conversation';
    if (workflow === 'speaking' && !this.speech.status().configured) throw new AppError(503, 'SPEECH_NOT_CONFIGURED', this.speech.status().reason);

    const runId = this.repo.startRun(userId, language, workflow === 'tool' ? `tool:${request.tool}` : workflow);
    const abort = new AbortController();
    const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(workflow === 'tool' ? 600000 : 240000), ...(requestSignal ? [requestSignal] : [])]);
    const outputs = {};
    let firstFailure;
    const invoke = async (id, task, dependencies = {}) => {
      signal.throwIfAborted();
      const stepId = this.repo.startStep(runId, id);
      try {
        const definition = agents[id];
        const output = await this.ai.generate({ ...definition, context: this.repo.context(userId, language, id), task, dependencies, signal });
        try { validateAgentSemantics(id, output, task); }
        catch { throw new AppError(502, 'INVALID_AI_OUTPUT', 'The AI returned an inconsistent learning activity. Please try again.'); }
        outputs[id] = output;
        this.repo.finishStep(stepId, output);
        return output;
      } catch (error) {
        this.repo.finishStep(stepId, null, publicError(error).code);
        firstFailure ||= error;
        abort.abort();
        throw error;
      }
    };
    const group = async (...tasks) => {
      const results = await Promise.allSettled(tasks.map(fn => fn()));
      const failed = results.find(result => result.status === 'rejected');
      if (failed) throw firstFailure || failed.reason;
    };
    const serviceStep = async (name, action) => {
      signal.throwIfAborted();
      const id = this.repo.startStep(runId, name);
      try { const result = await action(); this.repo.finishStep(id, result); return result; }
      catch (error) { this.repo.finishStep(id, null, publicError(error).code); throw error; }
    };
    const updatePlanAndProgress = async () => {
      await invoke('learningPath', { instruction: 'Update the learning plan using this new performance.', currentActivity: input }, { ...outputs });
      await invoke('progress', { instruction: 'Analyze this activity with the persisted history and recommend the next best activity.', currentActivity: input }, { ...outputs });
    };

    try {
      let toolExecution;
      if (workflow === 'tool') {
        toolExecution = await executeLanguageTool({ request, profile, invoke, group, serviceStep, services:this.services, signal, outputs, session, aiConfigured:this.ai.status().configured });
        input = toolExecution.input;
      } else if (workflow === 'conversation') {
        await group(
          () => invoke('tutor', { learnerMessage: request.message }),
          () => invoke('grammar', { learnerText: request.message }),
        );
        await group(
          () => invoke('assessment', { learnerResponse: request.message, scope: 'Short conversation; an informal estimate.' }, { tutor: outputs.tutor, grammar: outputs.grammar }),
          () => invoke('vocabulary', { learnerText: request.message }, { tutor: outputs.tutor, grammar: outputs.grammar }),
        );
        await updatePlanAndProgress();
      } else if (workflow === 'createActivity') {
        await invoke('learningPath', { instruction: 'Update the learning plan and recommend how this requested activity fits.', requestedKind: request.kind, focus: request.focus || profile.goal });
        await invoke('content', { kind: request.kind, focus: request.focus || profile.goal }, { learningPath: outputs.learningPath });
        if (profile.trainingFocus === 'culture' || /cultur|idiom|regional/i.test(request.focus || '')) {
          await invoke('culture',{ text:outputs.content.text, targetLanguage:language, dialect:profile.dialect });
        }
        await group(
          () => invoke('vocabulary', { learningMaterial: outputs.content.text }, { content: outputs.content }),
          () => invoke('progress', { instruction: 'Recommend a next step. This activity has been generated, not yet completed.' }, { learningPath: outputs.learningPath, content: outputs.content }),
        );
      } else if (workflow === 'assessActivity') {
        await group(
          () => invoke('assessment', input),
          () => invoke('grammar', { learnerText: request.text || 'Multiple choice responses are supplied; explain wrong choices without inventing learner sentences.', objectiveResults: input.objectiveResults, activity: activity.content }),
        );
        if (activity.kind === 'writing') await invoke('writing',{ operation:'writing',text:request.text,targetLanguage:language,purpose:activity.content.writingPrompt },{ grammar:outputs.grammar,assessment:outputs.assessment });
        await invoke('vocabulary', { learnerResponse: request.text, objectiveResults: input.objectiveResults }, { grammar: outputs.grammar, assessment: outputs.assessment });
        await updatePlanAndProgress();
      } else if (workflow === 'speaking') {
        const stepId = this.repo.startStep(runId, 'speechService');
        try {
          const evidence = await this.speech.analyze({ audio: request.audio, locale: profile.accent || languages[language], referenceText: activity.content.referenceText, signal });
          this.repo.finishStep(stepId, evidence);
          input = { activity: activity.content, learnerText: evidence.transcript, speechEvidence: evidence };
          durationSeconds = Math.round(evidence.durationSeconds);
          score = evidence.pronunciation?.pronunciation;
          await group(
            () => invoke('speaking', input),
            () => invoke('assessment', { ...input, scope: 'Language performance in a short read-aloud exercise. Only use supplied speech measurements.' }),
            () => invoke('pronunciation',{ ...input,text:activity.content.referenceText,targetLanguage:language,accent:profile.accent }),
          );
        } catch (error) {
          // The service step has already completed if a subsequent agent failed.
          if (!input.speechEvidence) this.repo.finishStep(stepId, null, publicError(error).code);
          throw error;
        }
        await group(
          () => invoke('grammar', { learnerText: input.learnerText, scope: 'This is a transcript. Consider recognition errors; do not invent pronunciation measurements.' }, { speaking: outputs.speaking }),
          () => invoke('vocabulary', { learnerText: input.learnerText }, { speaking: outputs.speaking, assessment: outputs.assessment }),
        );
        await updatePlanAndProgress();
      } else if (workflow === 'review') {
        await group(
          () => invoke('vocabulary', input),
          () => invoke('assessment', { ...input, scope: 'Self-reported word recall, not an objective language assessment. Explain what further evidence would help.' }),
        );
        await updatePlanAndProgress();
      } else {
        await invoke('learningPath', { instruction: workflow === 'plan' ? 'Create or update the learner plan using the actual history.' : 'Adapt the plan to the actual recent learning activity.' });
        await invoke('progress', { instruction: 'Use the actual history and plan to explain progress and recommend the next activity.' }, { learningPath: outputs.learningPath });
      }
      signal.throwIfAborted();
      const savedActivity = this.repo.saveLearning({ userId, language, outputs, kind, input, score: workflow === 'review' ? null : score,
        durationSeconds, activityId: activity?.id, activity: toolExecution?.activity || (workflow === 'createActivity' ? outputs.content : undefined), review, runId,
        toolRecord:toolExecution ? { tool:request.tool, input:toolExecution.input, result:toolExecution.result } : undefined,
        enrollProfile:toolExecution?.enrollProfile, communication:toolExecution?.communication });
      // Agent memory and answer keys remain server-side. All results are traceable to this run.
      const publicOutputs = Object.fromEntries(Object.entries(outputs).filter(([id]) => id !== 'content').map(([id, result]) => {
        const { memory, ...data } = result;
        if (id === 'grammar') data.exercises = data.exercises.map(({ prompt, options }) => ({ prompt, options }));
        return [id, data];
      }));
      return { runId, language, outputs: publicOutputs, activity: publicActivity(savedActivity),
        ...(toolExecution ? { toolResult:toolExecution.result } : {}),
        ...(input.objectiveResults ? { objectiveResults: input.objectiveResults, score } : {}),
        ...(input.speechEvidence ? { speechEvidence: input.speechEvidence } : {}),
        ...(review ? { nextReviewAt: review.dueAt } : {}) };
    } catch (error) {
      abort.abort();
      const visible = signal.aborted && !(error instanceof AppError)
        ? new AppError(504, 'WORKFLOW_INTERRUPTED', 'The agent workflow was interrupted. Your learning progress has not been changed.') : error;
      this.repo.finishRun(runId, publicError(visible).code);
      throw visible;
    }
  }
}
