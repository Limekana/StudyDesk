// Exam difficulty — how many days before the exam the study plan starts, and
// the colour each level is shown in.
//
// Pulled out of App.jsx (SD-6) because both the AddExamModal (now in
// features/plan) and ExamCard (still in App.jsx) need them, and a component
// file cannot export constants under react-refresh/only-export-components.

export const DIFFICULTY_DAYS = { easy: 3, medium: 7, hard: 14, brutal: 21 };
export const DIFFICULTY_COLORS = { easy: '#2e7d52', medium: '#d4860a', hard: '#c0392b', brutal: '#6d3fa0' };
