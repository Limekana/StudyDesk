import { describe, it, expect, vi } from 'vitest';
import { lessonsOn } from './timetable.js';
import { addDays } from './dates.js';

// v1.18.1 (StudyDesk#150) — fortnightly lessons on a term that inherits its
// dates showed every week, and the Calendar and the widget counted A/B weeks
// from Monday whatever the user's week start, so they could disagree with
// Attendance. (The callers now pass the week start; lessonsOn is what decides.)

const lesson = (id, termId, weekday, weekParity) => ({
  id, termId, weekday, weekParity, subjectId: 'c1', startsAt: '09:00', endsAt: '10:00',
});
const ids = (state, iso, weekStart) => lessonsOn(state, iso, weekStart).map((l) => l.id);

describe('A/B weeks on a term that inherits its dates (StudyDesk#150)', () => {
  // The semester starts Monday 2026-08-31; the period leaves its dates blank.
  const state = {
    courses: { c1: { name: 'Physics' } },
    academicTerms: [
      { id: 's', level: 'semester', parentId: null, name: 'Autumn', startsOn: '2026-08-31', endsOn: '2026-12-20' },
      { id: 'p', level: 'period', parentId: 's', name: 'Period 1', startsOn: '', endsOn: '' },
    ],
    timetableEntries: [lesson('b-week', 'p', 1, 2)],
  };

  it('a week-B lesson shows every other Monday, not every Monday', () => {
    const mondays = [0, 7, 14, 21].map((d) => addDays('2026-08-31', d));
    expect(mondays.map((iso) => ids(state, iso, 1).length)).toEqual([0, 1, 0, 1]);
  });
});

describe('the week start decides where an A/B week begins (StudyDesk#150)', () => {
  // A term starting on Sunday 2026-08-30, with a week-A lesson on Mondays.
  const state = {
    courses: { c1: { name: 'Physics' } },
    academicTerms: [{ id: 's', level: 'semester', parentId: null, name: 'Autumn', startsOn: '2026-08-30', endsOn: '2026-12-20' }],
    timetableEntries: [lesson('a-week', 's', 1, 1)],
  };

  it('a Sunday-first week puts the first Monday in week A', () => {
    expect(ids(state, '2026-08-31', 0)).toEqual(['a-week']);
  });

  it('a Monday-first week reads the same Monday differently, which is why every view must pass the same one', () => {
    expect(ids(state, '2026-08-31', 1)).toEqual([]);
  });
});

// The widget (todayPlan) now passes the user's week start. Forced to Sunday
// through the override, so the answer does not depend on the test machine.
describe('the widget agrees with the Calendar and Attendance (StudyDesk#150)', () => {
  const state = {
    courses: { c1: { name: 'Physics' } },
    academicTerms: [{ id: 's', level: 'semester', parentId: null, name: 'Autumn', startsOn: '2026-08-30', endsOn: '2026-12-20' }],
    timetableEntries: [lesson('a-week', 's', 1, 1)],
    plannedSessions: [],
  };

  it('uses the week start the user chose', async () => {
    const store = new Map([['studydesk-week-start', '0']]);
    vi.stubGlobal('localStorage', { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) });
    try {
      const { todayPlan } = await import('../widget/glance.js');
      const plan = todayPlan(state, '2026-08-31');
      expect(plan.filter((x) => x.kind === 'lesson').map((x) => x.id)).toEqual(['a-week']);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
