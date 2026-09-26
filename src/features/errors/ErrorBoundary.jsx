// v1.16 (limecore#16) — no render error is a blank screen any more.
//
// Before this, any throw during render unmounted the whole tree and left a
// white page with no way out but killing the app (the v1.10.0 blank-screen
// release is the precedent). The recovery screen offers the three things that
// help: reload, send this one report, and export your data.
//
// It depends on nothing that might be what broke: no context, no reducer
// state. The export reads the persisted snapshot straight from storage, and
// strings go through i18next directly with English fallbacks, so a crash in
// the i18n layer still leaves a readable page.
import { Component } from 'react';
import i18n from '../../i18n';
import { buildReport, errorReportsEnabled, sendReport } from '../../lib/errorReports.js';
import { downloadExport } from '../../lib/dataRights.js';
import { supabase } from '../../lib/supabase.js';
import '../../styles/errors.css';

const tr = (key, fallback, opts) => {
  try { return i18n.t(key, { defaultValue: fallback, ...opts }); } catch { return fallback; }
};

export default class ErrorBoundary extends Component {
  state = { error: null, report: null, status: null, exported: false };

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error) {
    const report = buildReport(error);
    this.setState({ report });
    // With the Settings switch on, the report goes by itself.
    if (errorReportsEnabled()) {
      this.setState({ status: 'sending' });
      void sendReport(report).then((status) => this.setState({ status }));
    }
  }

  send = () => {
    const { report } = this.state;
    if (!report) return;
    this.setState({ status: 'sending' });
    void sendReport(report, { consent: true }).then((status) => this.setState({ status }));
  };

  exportData = async () => {
    try {
      // The reducer may be what broke, so export what was last persisted.
      let snapshot = {};
      try { snapshot = JSON.parse(localStorage.getItem('studydesk-v1') || '{}') || {}; } catch { /* empty export */ }
      const { data } = await supabase.auth.getSession();
      await downloadExport(snapshot, data?.session ?? null);
      this.setState({ exported: true });
    } catch { /* the export has its own failure surface elsewhere */ }
  };

  render() {
    if (!this.state.error) return this.props.children;
    const { report, status, exported } = this.state;
    const sent = status === 'sent' || status === 'duplicate';

    return (
      <div className="crash-page" role="alert">
        <div className="crash-card">
          <div className="crash-eyebrow">{tr('crash.eyebrow', 'Error')}</div>
          <h1 className="crash-title">{tr('crash.title', 'Something went wrong')}</h1>
          <p className="crash-body">
            {tr('crash.body', 'This screen hit an error it could not recover from. Your data is safe on this device.')}
          </p>
          {report && <div className="crash-meta">{report.error_name} · {report.screen}</div>}
          <div className="crash-actions">
            <button type="button" className="btn" onClick={() => window.location.reload()}>
              {tr('crash.reload', 'Reload')}
            </button>
            {sent ? (
              <div className="crash-status">{tr('crash.sent', 'Report sent. Thank you.')}</div>
            ) : status === 'guest' ? (
              <div className="crash-status">{tr('crash.guest', 'Error reports need an account, so nothing was sent.')}</div>
            ) : (
              <button type="button" className="btn-outline" onClick={this.send} disabled={!report || status === 'sending'}>
                {status === 'sending'
                  ? tr('crash.sending', 'Sending…')
                  : status === 'failed'
                    ? tr('crash.retry', 'Could not send. Try again')
                    : tr('crash.send', 'Send this report')}
              </button>
            )}
            <button type="button" className="btn-outline" onClick={this.exportData}>
              {exported ? tr('crash.exported', 'Export downloaded') : tr('crash.export', 'Export my data')}
            </button>
          </div>
          {!sent && status !== 'guest' && (
            <p className="crash-note">
              {tr('crash.whatIsSent', 'A report says which error happened and where in our code. It never includes what you entered.')}
            </p>
          )}
        </div>
      </div>
    );
  }
}
