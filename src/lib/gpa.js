// GPA + grade-mode helpers. Mirrors Nexus's calc exactly so the two apps
// display the same number for the same data.

/**
 * US percentage → 4.0 grade points (standard letter-grade ladder).
 */
export function gradeToPoints(percent) {
  if (percent >= 93) return 4.0;
  if (percent >= 90) return 3.7;
  if (percent >= 87) return 3.3;
  if (percent >= 83) return 3.0;
  if (percent >= 80) return 2.7;
  if (percent >= 77) return 2.3;
  if (percent >= 73) return 2.0;
  if (percent >= 70) return 1.7;
  if (percent >= 67) return 1.3;
  if (percent >= 60) return 1.0;
  return 0;
}

/**
 * Weighted average across courses.
 *   - mode 'us': converts each percent to 4.0 points first, then weights.
 *   - mode 'ib': straight weighted mean on the 1–7 scale.
 *
 * @param {Array<{grade:number, credits:number}>} courses
 * @param {'us'|'ib'} mode
 * @returns {number} GPA value, rounded to 2 decimals.
 */
export function calculateGPA(courses, mode = 'ib') {
  if (!courses || courses.length === 0) return 0;
  const totalWeight = courses.reduce((s, c) => s + (Number(c.credits) || 0), 0);
  if (totalWeight === 0) return 0;
  if (mode === 'ib') {
    const sum = courses.reduce((s, c) => s + (Number(c.grade) || 0) * (Number(c.credits) || 0), 0);
    return Math.round((sum / totalWeight) * 100) / 100;
  }
  const sum = courses.reduce(
    (s, c) => s + gradeToPoints(Number(c.grade) || 0) * (Number(c.credits) || 0),
    0,
  );
  return Math.round((sum / totalWeight) * 100) / 100;
}

/**
 * Collapse a subject's multiple grade rows into one effective grade,
 * weighted by per-grade `weight`. If a subject has no grades, returns null.
 */
export function subjectEffectiveGrade(grades) {
  const live = (grades || []).filter((g) => !g.deletedAt);
  if (live.length === 0) return null;
  const totalW = live.reduce((s, g) => s + (Number(g.weight) || 0), 0);
  if (totalW === 0) {
    // Equal-weight fallback: simple mean.
    const sum = live.reduce((s, g) => s + (Number(g.grade) || 0), 0);
    return sum / live.length;
  }
  const sum = live.reduce((s, g) => s + (Number(g.grade) || 0) * (Number(g.weight) || 0), 0);
  return sum / totalW;
}

/**
 * Build the per-subject {grade, credits} array the GPA function expects,
 * by collapsing grade rows per subject and discarding subjects with no grades.
 */
export function subjectsWithEffectiveGrades(subjects, grades) {
  return Object.values(subjects)
    .filter((s) => !s.deletedAt)
    .map((s) => {
      const own = (grades || []).filter((g) => g.subjectId === s.id && !g.deletedAt);
      const eff = subjectEffectiveGrade(own);
      return eff == null
        ? null
        : { id: s.id, name: s.name, grade: eff, credits: Number(s.credits) || 1 };
    })
    .filter(Boolean);
}
