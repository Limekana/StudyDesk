import { describe, it, expect } from 'vitest';
import { studyStartDate, daysUntil } from './deadlines.js';

// v1.18.1 (StudyDesk#148): an exam's date can be cleared, and studyStartDate
// threw on it, crashing the Plan tab on every device that pulled the row.
describe('studyStartDate', () => {
  it('is null for an exam with no date, null or empty', () => {
    expect(studyStartDate({ dueDate: null, difficulty: 'hard' })).toBeNull();
    expect(studyStartDate({ dueDate: '' })).toBeNull();
    expect(daysUntil(studyStartDate({ dueDate: null }))).toBeNull();
  });

  it('still counts back from a dated exam', () => {
    expect(studyStartDate({ dueDate: '2026-10-20', difficulty: 'medium' })).toBe('2026-10-13');
  });
});
