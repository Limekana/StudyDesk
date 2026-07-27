import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App as CapApp } from '@capacitor/app';
import { supabase, OAUTH_REDIRECT_URL } from '../../lib/supabase.js';
import { inheritFromNexus } from '../../lib/suiteSso.js';
import { setGuestMode } from '../../lib/guestMode.js';
import { translateAuthError } from '../../lib/authErrors.js';

// v1.8 / ACT-3 — has this device ever completed first run? `studydesk-onboarded`
// is written at the end of onboarding, which lives *behind* this gate, so an
// unset flag is a sound "never been here before" test at gate time. Same flag
// App.jsx gates the onboarding wizard on — no new flag needed.
function hasOnboarded() {
  try {
    return localStorage.getItem('studydesk-onboarded') === '1';
  } catch {
    return false;
  }
}

const authCss = `
.auth-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:32px 20px;background:var(--bg);}
.auth-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:36px 32px;width:100%;max-width:420px;box-shadow:var(--shadow-md);}
.auth-wordmark{font-family:var(--font-display);font-size:28px;font-weight:600;text-align:center;margin-bottom:6px;}
.auth-tagline{font-family:var(--font-mono);font-size:11px;color:var(--muted);text-align:center;letter-spacing:0.08em;margin-bottom:28px;}
.auth-title{font-family:var(--font-display);font-size:20px;margin-bottom:6px;text-align:center;}
.auth-sub{font-size:12px;color:var(--muted);text-align:center;margin-bottom:22px;}
/* v1.1 — UI/UX review #20: padding 11px → 14px and added min-height: 44px
   so the primary Google CTA meets WCAG 2.5.5. */
.auth-google{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:44px;background:#fff;color:#1a1814;border:1px solid var(--border2);padding:14px 14px;border-radius:6px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.05em;text-transform:uppercase;cursor:pointer;transition:all 0.1s;font-weight:500;}
.auth-google:hover{border-color:var(--text);}
.auth-google:disabled{opacity:0.5;cursor:not-allowed;}
.auth-google-icon{width:16px;height:16px;flex-shrink:0;}
/* v1.4 — Nexus SSO button. Inverted-card treatment marks it as the
   suite-native path, visually distinct from Google's white-card. Matches
   the editorial palette: dark text-color background with the bg as type. */
/* v1.1 — UI/UX review #20: padding 11px → 14px and added min-height: 44px
   so the primary suite-native CTA meets WCAG 2.5.5. */
.auth-nexus{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;min-height:44px;background:var(--text);color:var(--bg);border:1px solid var(--text);padding:14px 14px;border-radius:6px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.05em;text-transform:uppercase;cursor:pointer;transition:all 0.1s;font-weight:500;margin-bottom:10px;}
.auth-nexus:hover{opacity:0.88;}
.auth-nexus:disabled{opacity:0.5;cursor:not-allowed;}
.auth-nexus-glyph{display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;font-family:var(--font-display);font-weight:600;font-size:14px;line-height:1;}
.auth-nexus-note{margin-top:-4px;margin-bottom:10px;font-family:var(--font-mono);font-size:9px;letter-spacing:0.08em;color:var(--muted2);text-align:center;}
/* v1.8 — ACT-4. Email/password is collapsed behind this control so the guest
   link clears the fold on <=640px viewports. Matches .auth-google's metrics
   (min-height 44px, mono uppercase) but with no fill, marking it as the
   tertiary path rather than a third sign-in provider. */
.auth-email-toggle{width:100%;min-height:44px;background:none;color:var(--muted);border:1px solid var(--border);padding:14px 14px;border-radius:6px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.05em;text-transform:uppercase;cursor:pointer;transition:all 0.1s;margin-top:10px;}
.auth-email-toggle:hover{border-color:var(--text);color:var(--text);}
.auth-email-toggle:disabled{opacity:0.5;cursor:not-allowed;}
.auth-divider{display:flex;align-items:center;gap:10px;margin:22px 0;color:var(--muted2);font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;}
.auth-divider::before,.auth-divider::after{content:'';flex:1;height:1px;background:var(--border);}
.auth-submit{width:100%;margin-top:8px;padding:11px 18px;font-size:12px;}
.auth-toggle{text-align:center;margin-top:18px;font-size:12px;color:var(--muted);display:flex;align-items:center;justify-content:center;gap:6px;flex-wrap:wrap;}
/* v1.1 — UI/UX review #16 (Blocker): padding:0 produced a ~16px tap target on the
   ONLY way to switch between sign-in / sign-up. Now: 12px padding + 44px min-height
   meets WCAG 2.5.5; underline lifted with stronger weight + offset for tap clarity (#22). */
.auth-toggle button{background:none;border:none;color:var(--text);cursor:pointer;font:inherit;font-weight:600;text-decoration:underline;text-underline-offset:3px;padding:12px 10px;min-height:44px;display:inline-flex;align-items:center;border-radius:4px;}
.auth-toggle button:hover{background:var(--surface2);}
/* v1.1 — UI/UX review #17: tokenized error palette (was hardcoded #fee/#fcc/#c0392b).
   Tokens live in :root in App.jsx so the editorial palette controls destructive surfaces too. */
.auth-error{background:var(--danger-bg);border:1px solid var(--danger-border);color:var(--danger);padding:10px 12px;border-radius:4px;font-size:12px;margin-bottom:14px;}
.auth-info{background:var(--surface2);border:1px solid var(--border);color:var(--muted);padding:10px 12px;border-radius:4px;font-size:12px;margin-bottom:14px;}
/* v1.1 auth UX — Continue as guest. Lives outside auth-card, visually distinct
   from the sign-in options so it doesn't read as a third login method. The
   caption below explains the local-only trade-off. */
.auth-guest{margin-top:18px;display:flex;flex-direction:column;align-items:center;gap:6px;}
.auth-guest button{background:none;border:none;color:var(--muted);font:inherit;font-size:13px;cursor:pointer;text-decoration:underline;text-underline-offset:3px;padding:6px 10px;}
.auth-guest button:hover{color:var(--text);}
.auth-guest button:disabled{opacity:0.5;cursor:not-allowed;}
.auth-guest-note{font-family:var(--font-mono);font-size:10px;letter-spacing:0.06em;color:var(--muted2);text-align:center;margin:0 12px;line-height:1.4;}
.auth-legal-note{font-size:10px;color:var(--muted2);text-align:center;margin:10px 12px 0;line-height:1.5;}
.auth-legal-note a{color:var(--muted);text-decoration:underline;}
/* v1.8 — ACT-4. Short viewports get tighter chrome so the guest link survives
   the expanded email form too. Keyed on height, not width: the fold problem is
   vertical, and 380x732 phones must keep the roomier editorial spacing. */
@media (max-height:680px){
  .auth-wrap{padding:16px 20px;}
  .auth-card{padding:22px 24px;}
  .auth-tagline{margin-bottom:18px;}
  .auth-divider{margin:14px 0;}
  .auth-guest{margin-top:12px;}
}
`;

function GoogleIcon() {
  return (
    <svg className="auth-google-icon" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
      <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
      <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.99.66-2.25 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
      <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
      <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
    </svg>
  );
}

export default function AuthGate() {
  const { t } = useTranslation();
  // ACT-3 — read once on mount. The flag can't change while the gate is on
  // screen, and re-reading would let the copy shift under the user mid-session.
  const [firstRun] = useState(() => !hasOnboarded());
  // ACT-3 — was a hardcoded 'signin', which rendered "Welcome back" / "Pick up
  // where you left off." to someone who had never opened the app.
  const [mode, setMode] = useState(() => (hasOnboarded() ? 'signin' : 'signup'));
  // ACT-4 — email/password collapsed by default. Four parallel paths
  // (Nexus · Google · email · guest) pushed "Continue as guest" below the fold
  // on <=640px viewports; hiding the form until asked for reclaims ~180px and
  // is the same pattern NCC has shipped since v1.1.
  const [showEmail, setShowEmail] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);
  const [nexusAvailable, setNexusAvailable] = useState(false);
  const [, setNexusReason] = useState('');

  // v1.4 — probe NCC's session provider on mount. If a session is available,
  // show the "Continue with Nexus" affordance as the primary option. Probe is
  // silent on failure — falls back to Google/email without complaint.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let cancelled = false;
    (async () => {
      try {
        const { inheritFromNexus: _probe } = await import('../../lib/suiteSso.js');
        // We can't call inheritFromNexus to probe because it would set the
        // session. Instead, run the underlying query directly via the same
        // plugin and only display the button — the button's onClick is what
        // does the actual inherit.
        const { registerPlugin } = await import('@capacitor/core');
        const SuiteSso = registerPlugin('SuiteSso');
        const result = await SuiteSso.getNexusSession();
        if (cancelled) return;
        if (result.available) {
          setNexusAvailable(true);
        } else {
          setNexusReason(result.reason || '');
        }
        void _probe; // silence unused import warning (kept as docs anchor)
      } catch {
        // Plugin missing or errored — fall back to Google/email silently.
      }
    })();
    return () => { cancelled = true; };
  }, []);

  async function onNexus() {
    setErr(''); setInfo(''); setLoading(true);
    try {
      const result = await inheritFromNexus();
      if (!result.ok) {
        setErr(result.reason || t('auth.errNexus'));
      }
      // On success, supabase.auth.onAuthStateChange fires and App.jsx
      // takes over — no further action needed here.
    } catch (e) {
      setErr(translateAuthError(e, t, 'auth.errNexusFailed'));
    } finally {
      setLoading(false);
    }
  }

  // Deep-link listener (native only) — exchange the OAuth code that
  // Supabase appends to the redirect URL after Google sign-in.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let subPromise = CapApp.addListener('appUrlOpen', async (event) => {
      try {
        const url = event.url || '';
        // Match case-insensitively — Android delivers whatever case the
        // browser sent, but our intent filter only matches lowercase so
        // in practice this will always be lowercase. Defensive lowercase
        // costs nothing.
        if (!url.toLowerCase().startsWith('com.studydesk.app://login-callback')) return;
        const qs = url.split('?')[1] || '';
        const params = new URLSearchParams(qs);
        const code = params.get('code');
        const errParam = params.get('error_description') || params.get('error');
        if (errParam) {
          setErr(errParam);
        } else if (code) {
          const { error } = await supabase.auth.exchangeCodeForSession(code);
          if (error) setErr(translateAuthError(error, t));
        }
      } catch (e) {
        setErr(translateAuthError(e, t, 'auth.errCallback'));
      } finally {
        try { await Browser.close(); } catch { /* not always open */ }
      }
    });
    return () => { subPromise.then((s) => s.remove()).catch(() => {}); };
    // `t` is a dependency because the callback translates OAuth failures. In
    // practice it never changes while the gate is mounted (the language picker
    // is onboarding step 0, which renders behind this gate), and re-running is
    // a clean remove/add of the listener anyway.
  }, [t]);

  async function onSubmit(e) {
    e.preventDefault();
    setErr(''); setInfo(''); setLoading(true);
    try {
      if (mode === 'signup') {
        const { error } = await supabase.auth.signUp({ email, password });
        if (error) throw error;
        // Email confirmation is disabled in the Supabase project — session lands immediately.
        // If it's ever re-enabled, surface a friendly note.
        const { data } = await supabase.auth.getSession();
        if (!data.session) setInfo(t('auth.infoConfirm'));
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e) {
      setErr(translateAuthError(e, t));
    } finally {
      setLoading(false);
    }
  }

  async function onGoogle() {
    setErr(''); setInfo(''); setLoading(true);
    try {
      const { data, error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: OAUTH_REDIRECT_URL,
          skipBrowserRedirect: true,
        },
      });
      if (error || !data?.url) throw error ?? new Error(t('auth.errGoogleStart'));
      if (Capacitor.isNativePlatform()) {
        await Browser.open({ url: data.url, presentationStyle: 'fullscreen' });
      } else {
        window.location.href = data.url;
      }
    } catch (e) {
      setErr(translateAuthError(e, t, 'auth.errGoogleFailed'));
      setLoading(false);
    }
  }

  return (
    <>
      <style>{authCss}</style>
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-wordmark">StudyDesk</div>
          {/* v1.1 — UI/UX review #21: was "SIGN IN TO SYNC WITH NEXUS", which
              now misleads guest-mode users (they explicitly opt out of sign-in).
              Neutral framing reads as a tagline rather than instruction. */}
          <div className="auth-tagline">{t('auth.tagline')}</div>

          {/* ACT-3 — on first run, lead with the local-first promise instead of
              an account pitch. This is the screen where "you don't need an
              account" has to land; the guest control is the last thing on the
              page. A first-run user who taps "Sign in" gets the returning
              framing, which is then correct — they're asserting they have one. */}
          <div className="auth-title">
            {firstRun && mode === 'signup'
              ? t('auth.titleFirstRun')
              : mode === 'signup'
                ? t('auth.titleSignup')
                : t('auth.titleSignin')}
          </div>
          <div className="auth-sub">
            {firstRun && mode === 'signup'
              ? t('auth.subFirstRun')
              : mode === 'signup'
                ? t('auth.subSignup')
                : t('auth.subSignin')}
          </div>

          {err && <div className="auth-error">{err}</div>}
          {info && <div className="auth-info">{info}</div>}

          {nexusAvailable && (
            <>
              <button type="button" className="auth-nexus" onClick={onNexus} disabled={loading}>
                <span className="auth-nexus-glyph">◈</span>
                {t('auth.nexus')}
              </button>
              <div className="auth-nexus-note">{t('auth.nexusNote')}</div>
            </>
          )}

          <button type="button" className="auth-google" onClick={onGoogle} disabled={loading}>
            <GoogleIcon />
            {t('auth.google')}
          </button>

          {/* ACT-4 — collapsed by default; the form and the sign-in/sign-up
              toggle only mount once the user asks for email. Keeping the toggle
              inside this branch matters: with the form hidden it would be
              switching a mode nothing on screen reflects. */}
          {!showEmail ? (
            <button
              type="button"
              className="auth-email-toggle"
              onClick={() => setShowEmail(true)}
              disabled={loading}
            >
              {mode === 'signup' ? t('auth.useEmailSignup') : t('auth.useEmail')}
            </button>
          ) : (
          <>
          <div className="auth-divider">{t('auth.or')}</div>

          <form onSubmit={onSubmit}>
            <div className="input-group">
              <label className="input-label">{t('auth.emailLabel')}</label>
              <input
                type="text"
                inputMode="email"
                autoCapitalize="none"
                autoCorrect="off"
                value={email}
                onChange={(e) => setEmail(e.target.value.trim())}
                required
              />
            </div>
            <div className="input-group">
              <label className="input-label">{t('auth.passwordLabel')}</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={6}
                required
              />
            </div>
            <button type="submit" className="btn auth-submit" disabled={loading}>
              {loading ? '…' : (mode === 'signup' ? t('auth.submitSignup') : t('auth.submitSignin'))}
            </button>
          </form>

          <div className="auth-toggle">
            {mode === 'signup' ? (
              <>{t('auth.haveAccount')} <button onClick={() => { setMode('signin'); setErr(''); setInfo(''); }}>{t('auth.linkSignin')}</button></>
            ) : (
              <>{t('auth.newHere')} <button onClick={() => { setMode('signup'); setErr(''); setInfo(''); }}>{t('auth.linkSignup')}</button></>
            )}
          </div>
          </>
          )}
        </div>

        {/* v1.1 auth UX — Continue as guest. Lets users skip auth and run
            StudyDesk fully locally. Cloud sync (Supabase realtime + outbox)
            is already gated on `session`, so a guest-mode user gets the full
            local feature set with sync turned off. */}
        <div className="auth-guest">
          <button
            type="button"
            onClick={() => {
              setGuestMode(true);
              window.dispatchEvent(new CustomEvent('studydesk:guest-mode-changed'));
            }}
            disabled={loading}
          >
            {t('auth.guest')}
          </button>
          <div className="auth-guest-note">
            {t('auth.guestNote')}
          </div>
          {/* GDPR Art. 8 — consent for an information society service is only
              valid from 16 (13 in some member states). We cannot verify ages and
              are not expected to, but a study app aimed at students should say
              the limit rather than stay silent, and should point at the option
              that needs no account. */}
          <div className="auth-legal-note">
            {t('auth.ageNote')}{' '}
            <a
              href="https://github.com/Limekana/StudyDesk/blob/main/PRIVACY.md"
              target="_blank"
              rel="noopener noreferrer"
            >
              {t('auth.privacyLink')}
            </a>
          </div>
        </div>
      </div>
    </>
  );
}
