import { useState, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { Browser } from '@capacitor/browser';
import { App as CapApp } from '@capacitor/app';
import { supabase, OAUTH_REDIRECT_URL } from '../../lib/supabase.js';

const authCss = `
.auth-wrap{display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:32px 20px;background:var(--bg);}
.auth-card{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:36px 32px;width:100%;max-width:420px;box-shadow:var(--shadow-md);}
.auth-wordmark{font-family:var(--font-display);font-size:28px;font-weight:600;text-align:center;margin-bottom:6px;}
.auth-tagline{font-family:var(--font-mono);font-size:11px;color:var(--muted);text-align:center;letter-spacing:0.08em;margin-bottom:28px;}
.auth-title{font-family:var(--font-display);font-size:20px;margin-bottom:6px;text-align:center;}
.auth-sub{font-size:12px;color:var(--muted);text-align:center;margin-bottom:22px;}
.auth-google{display:flex;align-items:center;justify-content:center;gap:10px;width:100%;background:#fff;color:#1a1814;border:1px solid var(--border2);padding:11px 14px;border-radius:6px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.05em;text-transform:uppercase;cursor:pointer;transition:all 0.1s;font-weight:500;}
.auth-google:hover{border-color:var(--text);}
.auth-google:disabled{opacity:0.5;cursor:not-allowed;}
.auth-google-icon{width:16px;height:16px;flex-shrink:0;}
.auth-divider{display:flex;align-items:center;gap:10px;margin:22px 0;color:var(--muted2);font-family:var(--font-mono);font-size:10px;letter-spacing:0.1em;}
.auth-divider::before,.auth-divider::after{content:'';flex:1;height:1px;background:var(--border);}
.auth-submit{width:100%;margin-top:8px;padding:11px 18px;font-size:12px;}
.auth-toggle{text-align:center;margin-top:18px;font-size:12px;color:var(--muted);}
.auth-toggle button{background:none;border:none;color:var(--text);cursor:pointer;font:inherit;text-decoration:underline;padding:0;}
.auth-error{background:#fee;border:1px solid #fcc;color:#c0392b;padding:10px 12px;border-radius:4px;font-size:12px;margin-bottom:14px;}
.auth-info{background:var(--surface2);border:1px solid var(--border);color:var(--muted);padding:10px 12px;border-radius:4px;font-size:12px;margin-bottom:14px;}
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
  const [mode, setMode] = useState('signin'); // 'signin' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [err, setErr] = useState('');
  const [info, setInfo] = useState('');
  const [loading, setLoading] = useState(false);

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
          if (error) setErr(error.message);
        }
      } catch (e) {
        setErr(e?.message || 'Sign-in callback failed');
      } finally {
        try { await Browser.close(); } catch { /* not always open */ }
      }
    });
    return () => { subPromise.then((s) => s.remove()).catch(() => {}); };
  }, []);

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
        if (!data.session) setInfo('Account created. Check your email to confirm.');
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password });
        if (error) throw error;
      }
    } catch (e) {
      setErr(e?.message || 'Authentication failed');
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
      if (error || !data?.url) throw error ?? new Error('Failed to start Google sign-in');
      if (Capacitor.isNativePlatform()) {
        await Browser.open({ url: data.url, presentationStyle: 'fullscreen' });
      } else {
        window.location.href = data.url;
      }
    } catch (e) {
      setErr(e?.message || 'Google sign-in failed');
      setLoading(false);
    }
  }

  return (
    <>
      <style>{authCss}</style>
      <div className="auth-wrap">
        <div className="auth-card">
          <div className="auth-wordmark">StudyDesk</div>
          <div className="auth-tagline">SIGN IN TO SYNC WITH NEXUS</div>

          <div className="auth-title">{mode === 'signup' ? 'Create account' : 'Welcome back'}</div>
          <div className="auth-sub">
            {mode === 'signup' ? 'Your data syncs across devices.' : 'Pick up where you left off.'}
          </div>

          {err && <div className="auth-error">{err}</div>}
          {info && <div className="auth-info">{info}</div>}

          <button type="button" className="auth-google" onClick={onGoogle} disabled={loading}>
            <GoogleIcon />
            Continue with Google
          </button>

          <div className="auth-divider">OR</div>

          <form onSubmit={onSubmit}>
            <div className="input-group">
              <label className="input-label">Email</label>
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
              <label className="input-label">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                minLength={6}
                required
              />
            </div>
            <button type="submit" className="btn auth-submit" disabled={loading}>
              {loading ? '…' : (mode === 'signup' ? 'Create account' : 'Sign in')}
            </button>
          </form>

          <div className="auth-toggle">
            {mode === 'signup' ? (
              <>Already have an account? <button onClick={() => { setMode('signin'); setErr(''); setInfo(''); }}>Sign in</button></>
            ) : (
              <>New here? <button onClick={() => { setMode('signup'); setErr(''); setInfo(''); }}>Create account</button></>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
