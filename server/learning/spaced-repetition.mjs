import { AppError } from '../errors.mjs';

// SM-2 style scheduling. Ratings are explicitly self-reported recall, not AI scores.
export function scheduleReview(word, rating, at = Date.now()) {
  const quality = { again: 0, hard: 3, good: 4, easy: 5 }[rating];
  if (quality === undefined) throw new AppError(400, 'INVALID_RATING', 'Choose again, hard, good, or easy.');
  const ease = Math.max(1.3, word.ease + 0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  const repetitions = quality < 3 ? 0 : word.repetitions + 1;
  let intervalDays = quality < 3 ? 10 / 1440
    : repetitions === 1 ? 1 : repetitions === 2 ? 6 : Math.max(1, Math.round(word.interval_days * ease));
  if (rating === 'hard') intervalDays = Math.max(1, Math.round(intervalDays * 0.6));
  if (rating === 'easy') intervalDays = Math.max(2, Math.round(intervalDays * 1.3));
  return { wordId: word.id, rating, ease, repetitions, intervalDays, dueAt: new Date(at + intervalDays * 86400000).toISOString() };
}
