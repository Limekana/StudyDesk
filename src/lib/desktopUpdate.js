// v1.15 (Item 12) — the desktop edition's "a newer release is out" state.
//
// One tiny store rather than a hook per component: the sidebar badge and the
// Settings "Check for updates" row both read it, and a manual check from
// Settings should light up the badge too without a second request. The work
// itself happens in the Electron main process (electron/update-check.cjs);
// this only mirrors its answer. On every non-desktop build `desktop` is null
// and the state stays idle forever.
//
// Shape: { status: 'idle' | 'checking' | 'available' | 'current' | 'error',
//          current?, latest? }
import { useSyncExternalStore } from 'react';
import { desktop } from './desktop.js';

let state = { status: 'idle' };
const listeners = new Set();

function set(next) {
  state = next;
  listeners.forEach((l) => l());
}

function subscribe(l) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function checkForDesktopUpdate(force = false) {
  if (!desktop?.checkForUpdate || state.status === 'checking') return;
  set({ status: 'checking' });
  desktop.checkForUpdate(force).then(
    (res) => set(res),
    () => set({ status: 'error', current: '', latest: null }),
  );
}

export function openDesktopUpdate() {
  void desktop?.openUpdate?.();
}

export function useDesktopUpdate() {
  return useSyncExternalStore(subscribe, () => state, () => state);
}
