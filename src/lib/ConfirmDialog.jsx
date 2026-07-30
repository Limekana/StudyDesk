// In-app replacement for window.confirm().
//
// Ported from nexus-command-center (NC-6) and LimeLog (LL-7), where the
// reasoning was worked out: on Android WebView the native dialog is the OS
// dialog, so its buttons come out in the *OS* language rather than the app's — a
// student running StudyDesk in Hindi got a translated message with English
// "OK / Cancel". It also renders LTR under dir="rtl", shows the package name as
// its title, and blocks the JS thread.
//
// Two of the three call sites this replaces are the account-deletion
// confirmations. An irreversible erasure spanning all three apps should not be
// gated behind a dialog titled com.StudyDesk.app.
//
// The API is deliberately promise-based and shaped like the thing it replaces,
// so a call site changes from
//     if (!confirm(msg)) return;
// to
//     if (!(await confirm(msg))) return;
// and nothing else about the surrounding logic moves. StudyDesk's callers all
// pass a plain string, so unlike the TypeScript ports this takes one rather
// than an options object.
//
// CSS lives in a template string beside the component, matching SettingsView
// and the rest of this codebase.
//
// The context and hook live in ./useConfirm.js so this module exports only a
// component — see the note there.

import { useCallback, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ConfirmContext } from './useConfirm.js';

const css = `
.cfd-backdrop{position:fixed;inset:0;z-index:200;display:flex;align-items:flex-end;justify-content:center;padding:16px;background:rgba(24,20,16,0.55);backdrop-filter:blur(3px);}
@media (min-width:640px){.cfd-backdrop{align-items:center;}}
.cfd-card{width:100%;max-width:380px;background:var(--surface);border:1px solid var(--border);border-radius:14px;padding:20px 22px;box-shadow:0 14px 40px rgba(0,0,0,0.22);}
.cfd-title{font-family:var(--font-display);font-size:16px;font-weight:600;color:var(--text);margin:0 0 8px;}
.cfd-msg{font-size:14px;line-height:1.55;color:var(--text);margin:0 0 18px;white-space:pre-line;}
.cfd-actions{display:flex;gap:8px;justify-content:flex-end;}
.cfd-btn{font-family:var(--font-mono);font-size:11px;letter-spacing:0.06em;text-transform:uppercase;padding:9px 16px;border-radius:8px;cursor:pointer;background:transparent;border:1px solid var(--border2);color:var(--muted);}
.cfd-btn--go{background:var(--danger);border-color:var(--danger);color:var(--danger-on,#fff);}
`;

export function ConfirmProvider({ children }) {
  const { t } = useTranslation();
  const [pending, setPending] = useState(null);
  const resolver = useRef(null);

  const confirm = useCallback((message, opts = {}) => {
    setPending({ message, ...opts });
    return new Promise((resolve) => {
      resolver.current = resolve;
    });
  }, []);

  const settle = useCallback((value) => {
    if (resolver.current) resolver.current(value);
    resolver.current = null;
    setPending(null);
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      {pending && (
        <>
          <style>{css}</style>
          {/* Dismissing by backdrop is a cancel, matching the native dialog. */}
          <div className="cfd-backdrop" role="dialog" aria-modal="true" onClick={() => settle(false)}>
            <div className="cfd-card" onClick={(e) => e.stopPropagation()}>
              {pending.title && <h2 className="cfd-title">{pending.title}</h2>}
              <p className="cfd-msg">{pending.message}</p>
              <div className="cfd-actions">
                <button className="cfd-btn" onClick={() => settle(false)}>
                  {pending.cancelLabel ?? t('common.cancel')}
                </button>
                <button className="cfd-btn cfd-btn--go" onClick={() => settle(true)} autoFocus>
                  {pending.confirmLabel ?? t('common.confirm')}
                </button>
              </div>
            </div>
          </div>
        </>
      )}
    </ConfirmContext.Provider>
  );
}
