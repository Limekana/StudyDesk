import { useState, useCallback } from 'react';
import { supabase } from '../../lib/supabase.js';
import * as sync from '../../lib/sync.js';

const css = `
.sv2-wrap{padding:16px 24px 80px;max-width:680px;margin:0 auto;}
.sv2-section{background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:18px 20px;margin-bottom:14px;}
.sv2-section-title{font-family:var(--font-mono);font-size:10px;letter-spacing:0.18em;color:var(--muted2);text-transform:uppercase;margin-bottom:14px;}
.sv2-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:8px 0;font-size:14px;}
.sv2-row + .sv2-row{border-top:1px solid var(--border);}
.sv2-row-label{color:var(--muted);font-size:12px;}
.sv2-row-value{font-family:var(--font-mono);font-size:12px;color:var(--text);text-align:right;word-break:break-all;}
.sv2-mode{display:inline-flex;border:1px solid var(--border2);border-radius:6px;overflow:hidden;}
.sv2-mode button{background:transparent;border:none;padding:6px 14px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.06em;text-transform:uppercase;cursor:pointer;color:var(--muted);}
.sv2-mode button.active{background:var(--text);color:var(--bg);}
.sv2-action{margin-top:14px;display:flex;gap:8px;flex-wrap:wrap;}
.sv2-signout{background:#c0392b;color:#fff;border:none;padding:9px 18px;font-family:var(--font-mono);font-size:11px;letter-spacing:0.08em;text-transform:uppercase;cursor:pointer;border-radius:4px;font-weight:500;}
.sv2-signout:hover{opacity:0.85;}
.sv2-status-dot{display:inline-block;width:8px;height:8px;border-radius:50%;margin-right:6px;vertical-align:middle;}
.sv2-link{color:var(--text);text-decoration:underline;font-size:12px;font-family:var(--font-mono);}
`;

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '—';
  const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return 'just now';
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
}

export default function SettingsView({ state, dispatch, showFlash, session }) {
  const [pulling, setPulling] = useState(false);
  const [lastPullAt, setLastPullAt] = useState(null);
  const [signingOut, setSigningOut] = useState(false);

  const subjects = Object.values(state.courses || {}).filter((c) => !c.deletedAt);
  const grades = (state.grades || []).filter((g) => !g.deletedAt);
  const sessions = (state.studySessions || []).filter((s) => !s.deletedAt);

  const mode = state.gradeMode || 'ib';

  const onSignOut = useCallback(async () => {
    if (!confirm('Sign out of StudyDesk? Your synced data stays in the cloud and will reappear when you sign back in.')) return;
    setSigningOut(true);
    try {
      await supabase.auth.signOut();
      showFlash('Signed out');
    } catch (e) {
      showFlash('Sign-out failed: ' + e.message);
    } finally {
      setSigningOut(false);
    }
  }, [showFlash]);

  const onPullNow = useCallback(async () => {
    if (!session) {
      showFlash('Not signed in');
      return;
    }
    setPulling(true);
    try {
      const remote = await sync.pullAllStudyData();
      dispatch({ type: 'MERGE_REMOTE', remote });
      setLastPullAt(new Date().toISOString());
      showFlash(`Synced: ${remote.subjects.length} subjects · ${remote.grades.length} grades · ${remote.sessions.length} sessions`);
    } catch (e) {
      showFlash('Pull failed: ' + e.message);
    } finally {
      setPulling(false);
    }
  }, [session, dispatch, showFlash]);

  const userEmail = session?.user?.email || '—';
  const userId = session?.user?.id;
  const userIdShort = userId ? `${userId.slice(0, 8)}…${userId.slice(-4)}` : '—';
  const provider = session?.user?.app_metadata?.provider || 'email';

  return (
    <>
      <style>{css}</style>
      <div className="sv2-wrap">
        {/* ── Account ── */}
        <div className="sv2-section">
          <div className="sv2-section-title">Account</div>
          {!session ? (
            <>
              <div className="sv2-row">
                <span className="sv2-row-label">Status</span>
                <span className="sv2-row-value">
                  <span className="sv2-status-dot" style={{ background: '#c0392b' }} />
                  Not signed in
                </span>
              </div>
              <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10 }}>
                Sign in to sync your courses, grades, and study sessions with Nexus Command Center.
                Sign-in surface is the launch screen — sign out from here and you'll see it next time.
              </div>
            </>
          ) : (
            <>
              <div className="sv2-row">
                <span className="sv2-row-label">Status</span>
                <span className="sv2-row-value">
                  <span className="sv2-status-dot" style={{ background: '#2e7d52' }} />
                  Signed in
                </span>
              </div>
              <div className="sv2-row">
                <span className="sv2-row-label">Email</span>
                <span className="sv2-row-value">{userEmail}</span>
              </div>
              <div className="sv2-row">
                <span className="sv2-row-label">Provider</span>
                <span className="sv2-row-value">{provider}</span>
              </div>
              <div className="sv2-row">
                <span className="sv2-row-label">User ID</span>
                <span className="sv2-row-value" title={userId}>{userIdShort}</span>
              </div>
              <div className="sv2-action">
                <button className="sv2-signout" onClick={onSignOut} disabled={signingOut}>
                  {signingOut ? 'Signing out…' : 'Sign out'}
                </button>
              </div>
            </>
          )}
        </div>

        {/* ── Sync ── */}
        <div className="sv2-section">
          <div className="sv2-section-title">Cloud sync</div>
          <div className="sv2-row">
            <span className="sv2-row-label">Connection</span>
            <span className="sv2-row-value">
              <span
                className="sv2-status-dot"
                style={{ background: session ? '#2e7d52' : '#7a7570' }}
              />
              {session ? 'Realtime active' : 'Offline (local only)'}
            </span>
          </div>
          <div className="sv2-row">
            <span className="sv2-row-label">Subjects</span>
            <span className="sv2-row-value">{subjects.length}</span>
          </div>
          <div className="sv2-row">
            <span className="sv2-row-label">Grades</span>
            <span className="sv2-row-value">{grades.length}</span>
          </div>
          <div className="sv2-row">
            <span className="sv2-row-label">Sessions</span>
            <span className="sv2-row-value">{sessions.length}</span>
          </div>
          <div className="sv2-row">
            <span className="sv2-row-label">Last manual pull</span>
            <span className="sv2-row-value">{fmtTime(lastPullAt)}</span>
          </div>
          {session && (
            <div className="sv2-action">
              <button className="btn-outline" onClick={onPullNow} disabled={pulling}>
                {pulling ? 'Pulling…' : 'Pull latest now'}
              </button>
            </div>
          )}
          <div style={{ fontSize: 11, color: 'var(--muted2)', marginTop: 10, lineHeight: 1.5 }}>
            Realtime pushes inbound changes within ~1.5 seconds. Pull-now is here for paranoia / debugging.
          </div>
        </div>

        {/* ── Grades ── */}
        <div className="sv2-section">
          <div className="sv2-section-title">Grades</div>
          <div className="sv2-row">
            <span className="sv2-row-label">Grade mode</span>
            <span className="sv2-row-value">
              <span className="sv2-mode">
                <button
                  className={mode === 'ib' ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'ib' })}
                >IB</button>
                <button
                  className={mode === 'us' ? 'active' : ''}
                  onClick={() => dispatch({ type: 'SET_GRADE_MODE', mode: 'us' })}
                >US</button>
              </span>
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--muted2)', marginTop: 6, lineHeight: 1.5 }}>
            IB: weighted average on the 1–7 scale. US: per-course percent → 4.0 grade points via the
            standard letter-grade ladder, then credit-weighted. Stored locally — does not sync with Nexus.
          </div>
        </div>

        {/* ── About ── */}
        <div className="sv2-section">
          <div className="sv2-section-title">About</div>
          <div className="sv2-row">
            <span className="sv2-row-label">App</span>
            <span className="sv2-row-value">StudyDesk</span>
          </div>
          <div className="sv2-row">
            <span className="sv2-row-label">Bundle ID</span>
            <span className="sv2-row-value">com.StudyDesk.app</span>
          </div>
          <div className="sv2-row">
            <span className="sv2-row-label">Backend</span>
            <span className="sv2-row-value" style={{ fontSize: 11 }}>
              hkktorzhaqnfqsnlstda.supabase.co
            </span>
          </div>
          <div className="sv2-row">
            <span className="sv2-row-label">Source</span>
            <span className="sv2-row-value">
              <a className="sv2-link" href="https://github.com/Limekana/StudyDesk" target="_blank" rel="noopener noreferrer">
                github.com/Limekana/StudyDesk
              </a>
            </span>
          </div>
          <div className="sv2-row">
            <span className="sv2-row-label">License</span>
            <span className="sv2-row-value">MIT</span>
          </div>
        </div>
      </div>
    </>
  );
}
