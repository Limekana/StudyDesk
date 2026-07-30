// Assignment types offered in the add-assignment modal.
//
// "Other" is not a dead end: picking it reveals a label field and the custom
// text is what gets stored, so this list is a set of shortcuts rather than a
// constraint (v1.8).
//
// In its own module because CourseModals.jsx and App.jsx both need it and
// react-refresh/only-export-components forbids a component file exporting a
// constant.
export const ASSIGN_TYPES = ["Essay","Problem Set","Lab","Reading","Exam","Project","Quiz","Other"];

/** The entry that reveals the free-text label field. */
export const OTHER_ASSIGN_TYPE = "Other";
