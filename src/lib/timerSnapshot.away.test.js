import { describe, it, expect } from 'vitest';
import { finishedWhileAway } from './timerSnapshot.js';

// v1.18.1 (StudyDesk#149) — a block that reached zero while TimerView was not
// mounted was never completed.
describe('finishedWhileAway (StudyDesk#149)', () => {
  const now = Date.UTC(2026, 9, 15, 12, 0, 0);
  const run = (over) => ({ running: true, mode: 'pomodoro', startedAt: now - 26 * 60_000, secsAtStart: 25 * 60, ...over });

  it('a countdown that ran out while away is finished', () => {
    expect(finishedWhileAway(run(), now)).toBe(true);
  });

  it('one still running, a paused one, a stopwatch, or nothing saved is not', () => {
    expect(finishedWhileAway(run({ startedAt: now - 10 * 60_000 }), now)).toBe(false);
    expect(finishedWhileAway(run({ running: false }), now)).toBe(false);
    expect(finishedWhileAway(run({ mode: 'stopwatch' }), now)).toBe(false);
    expect(finishedWhileAway({}, now)).toBe(false);
    expect(finishedWhileAway(null, now)).toBe(false);
  });
});
