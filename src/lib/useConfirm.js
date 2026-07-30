// Context and hook for ConfirmDialog, kept out of the .jsx deliberately.
//
// react-refresh/only-export-components fires when a module exports both a
// component and something else, because Fast Refresh can then only reload half
// of it. StudyDesk lints at --max-warnings 0 (SD-4), so the rule's own advice
// applies: the non-component exports live here and ConfirmDialog.jsx exports
// only the provider.

import { createContext, useContext } from 'react';

export const ConfirmContext = createContext(null);

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) throw new Error('useConfirm must be used inside <ConfirmProvider>');
  return ctx;
}
