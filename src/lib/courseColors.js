// The eight preset course colours.
//
// Separate from CoursePicker.jsx because react-refresh/only-export-components
// rejects a module exporting both a component and a constant, and StudyDesk
// lints at --max-warnings 0. This is the fourth component in the suite to need
// the split (both ConfirmDialogs, the guest avatar, and now this), so it is
// worth stating as a convention rather than rediscovering: in a .jsx/.tsx that
// exports a component, export nothing else.
//
// Chosen to stay legible on the cream-paper background. A custom colour can be
// anything the user likes, including something nearly invisible — that is their
// call, but it should not be the default one.
export const COURSE_COLORS = [
  '#c0392b', '#d4860a', '#2e7d52', '#1a5c9e',
  '#6d3fa0', '#b5470b', '#1e7d7d', '#8b4a62',
];
