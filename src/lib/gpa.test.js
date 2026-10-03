import { describe, it, expect } from 'vitest';
import { calculateGPA, subjectEffectiveGrade, subjectsWithEffectiveGrades } from './gpa.js';

// Characterization tests (v1.16, limecore#11). This is the number a student
// actually opens the app to see, and NCC mirrors the same calculation, so a
// change here silently desynchronises the two apps' displays for identical
// data.

describe('calculateGPA — ib mode', () => {
  it('takes a straight credit-weighted mean on the 1-7 scale', () => {
    expect(calculateGPA([{ grade: 6, credits: 2 }, { grade: 7, credits: 1 }], 'ib')).toBe(6.33);
  });

  it('defaults to ib when no mode is given', () => {
    expect(calculateGPA([{ grade: 6, credits: 1 }])).toBe(6);
  });

  it('rounds to two decimals', () => {
    expect(calculateGPA([{ grade: 5, credits: 3 }, { grade: 6, credits: 3 }], 'ib')).toBe(5.5);
    expect(calculateGPA([{ grade: 1, credits: 3 }], 'ib')).toBe(1);
  });

  it('weights by credits rather than counting courses equally', () => {
    const equal = calculateGPA([{ grade: 4, credits: 1 }, { grade: 7, credits: 1 }], 'ib');
    const weighted = calculateGPA([{ grade: 4, credits: 9 }, { grade: 7, credits: 1 }], 'ib');
    expect(equal).toBe(5.5);
    expect(weighted).toBe(4.3);
  });
});

describe('calculateGPA — us mode', () => {
  it('converts each percentage to 4.0 points before weighting', () => {
    expect(calculateGPA([{ grade: 95, credits: 1 }], 'us')).toBe(4);
    expect(calculateGPA([{ grade: 90, credits: 1 }], 'us')).toBe(3.7);
    expect(calculateGPA([{ grade: 60, credits: 1 }], 'us')).toBe(1);
  });

  it('scores anything under 60 as zero', () => {
    expect(calculateGPA([{ grade: 59, credits: 1 }], 'us')).toBe(0);
    expect(calculateGPA([{ grade: 0, credits: 1 }], 'us')).toBe(0);
  });

  it('places each letter-ladder boundary on the inclusive side', () => {
    // A boundary that drifts by one point moves a student's whole transcript.
    const at = (p) => calculateGPA([{ grade: p, credits: 1 }], 'us');
    expect([at(93), at(92)]).toEqual([4, 3.7]);
    expect([at(87), at(86)]).toEqual([3.3, 3.0]);
    expect([at(83), at(82)]).toEqual([3.0, 2.7]);
    expect([at(80), at(79)]).toEqual([2.7, 2.3]);
    expect([at(77), at(76)]).toEqual([2.3, 2.0]);
    expect([at(73), at(72)]).toEqual([2.0, 1.7]);
    expect([at(70), at(69)]).toEqual([1.7, 1.3]);
    expect([at(67), at(66)]).toEqual([1.3, 1.0]);
  });

  it('leaves no gap between the 1.3 band and the 1.0 band', () => {
    // 60-66 all land on 1.0; the ladder has no 1.1/1.2 step. Pinned because it
    // reads like an omission and is not one.
    expect(calculateGPA([{ grade: 61, credits: 1 }], 'us')).toBe(1);
    expect(calculateGPA([{ grade: 66, credits: 1 }], 'us')).toBe(1);
  });
});

describe('calculateGPA — degenerate input', () => {
  it('is zero for no courses', () => {
    expect(calculateGPA([], 'ib')).toBe(0);
    expect(calculateGPA(null, 'ib')).toBe(0);
    expect(calculateGPA(undefined, 'ib')).toBe(0);
  });

  it('is zero rather than NaN when every credit is zero', () => {
    expect(calculateGPA([{ grade: 6, credits: 0 }], 'ib')).toBe(0);
  });

  it('coerces a non-numeric grade or credit to zero instead of producing NaN', () => {
    expect(calculateGPA([{ grade: 'x', credits: 1 }], 'ib')).toBe(0);
    expect(calculateGPA([{ grade: 6, credits: 2 }, { grade: 6, credits: 'x' }], 'ib')).toBe(6);
  });
});

describe('subjectEffectiveGrade', () => {
  it('weights grade rows by their own weight', () => {
    expect(subjectEffectiveGrade([{ grade: 4, weight: 1 }, { grade: 6, weight: 3 }])).toBe(5.5);
  });

  it('falls back to a simple mean when every weight is zero', () => {
    expect(subjectEffectiveGrade([{ grade: 4, weight: 0 }, { grade: 6, weight: 0 }])).toBe(5);
  });

  it('treats a missing weight as zero, so an all-unweighted subject means equally', () => {
    expect(subjectEffectiveGrade([{ grade: 4 }, { grade: 6 }])).toBe(5);
  });

  it('excludes soft-deleted grade rows', () => {
    expect(
      subjectEffectiveGrade([{ grade: 4, weight: 1 }, { grade: 100, weight: 1, deletedAt: '2026-01-01' }]),
    ).toBe(4);
  });

  it('is null when the subject has no live grades', () => {
    expect(subjectEffectiveGrade([])).toBeNull();
    expect(subjectEffectiveGrade(null)).toBeNull();
    expect(subjectEffectiveGrade([{ grade: 4, deletedAt: '2026-01-01' }])).toBeNull();
  });
});

describe('subjectsWithEffectiveGrades', () => {
  const subjects = {
    s1: { id: 's1', name: 'Maths', credits: 2 },
    s2: { id: 's2', name: 'History', credits: 3 },
  };

  it('collapses each subject to one row the GPA function can take', () => {
    const out = subjectsWithEffectiveGrades(subjects, [
      { subjectId: 's1', grade: 6, weight: 1 },
      { subjectId: 's2', grade: 4, weight: 1 },
    ]);
    expect(out).toEqual([
      { id: 's1', name: 'Maths', grade: 6, credits: 2 },
      { id: 's2', name: 'History', grade: 4, credits: 3 },
    ]);
  });

  it('drops a subject that has no grades rather than scoring it zero', () => {
    const out = subjectsWithEffectiveGrades(subjects, [{ subjectId: 's1', grade: 6, weight: 1 }]);
    expect(out.map((s) => s.id)).toEqual(['s1']);
  });

  it('excludes a soft-deleted subject', () => {
    const out = subjectsWithEffectiveGrades(
      { ...subjects, s2: { ...subjects.s2, deletedAt: '2026-01-01' } },
      [{ subjectId: 's1', grade: 6, weight: 1 }, { subjectId: 's2', grade: 7, weight: 1 }],
    );
    expect(out.map((s) => s.id)).toEqual(['s1']);
  });

  it('defaults missing credits to 1 so a subject still counts', () => {
    const out = subjectsWithEffectiveGrades({ s1: { id: 's1', name: 'Maths' } }, [
      { subjectId: 's1', grade: 6, weight: 1 },
    ]);
    expect(out[0].credits).toBe(1);
  });

  it('feeds calculateGPA end to end', () => {
    const rows = subjectsWithEffectiveGrades(subjects, [
      { subjectId: 's1', grade: 7, weight: 1 },
      { subjectId: 's2', grade: 5, weight: 1 },
    ]);
    // (7×2 + 5×3) / 5
    expect(calculateGPA(rows, 'ib')).toBe(5.8);
  });
});
