// The calendar-feed subscription panel. Issue #44.
//
// ── Test 3 of the integration policy: invisible when unused ─────────────
//
//   > "No tab, no nav entry, no empty state. It lives in Settings, and a
//      student who doesn't use it never learns it exists."
//
// So this is one collapsed row in Settings until somebody opens it. There is
// no onboarding step, no banner, no badge, and no empty state anywhere else
// in the app. A student who never pastes a URL never sees a single pixel of
// this feature beyond the row that opens it.
//
// ── What it promises, and what it refuses to ────────────────────────────
//
// The help text says what ICS carries and what it does not, because the build
// plan asks for that explicitly: "This is 'due dates arrive on their own',
// not 'Canvas mirrored'; say so in the reply to #44 so nobody expects the
// latter." A feature that quietly under-delivers against an expectation it
// created is worse than one that states its limits up front.
//
// The vendor is named ONLY in the help string, never in code. Every LMS a
// student might be handed exports ICS, so the format is the integration.

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  loadFeeds, addFeed, removeFeed, updateFeed, refreshFeed,
  describeFeedUrl, isDue, mergeFeedItems,
} from '../../lib/calendarFeed.js';
import { toAssignments } from '../../lib/feedImport.js';
import { readJson, writeJson } from '../../lib/localStore.js';
import * as outbox from '../../lib/outbox.js';

// The UIDs each feed has imported, device-side. Needed for exactly one thing:
// removing a feed's rows when the user unsubscribes. It is NOT the identity
// mechanism — the assignment id is derived from the UID, so re-fetching is
// idempotent without consulting this.
const ITEMS_KEY = 'studydesk-calendar-feed-items';

function loadItems() {
  const v = readJson(ITEMS_KEY, {});
  return v && typeof v === 'object' ? v : {};
}

export default function CalendarFeeds({ state, dispatch, session, showFlash }) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [feeds, setFeeds] = useState(() => loadFeeds());
  const [url, setUrl] = useState('');
  const [courseId, setCourseId] = useState('');
  const [busy, setBusy] = useState(null);
  const [err, setErr] = useState('');

  const courses = Object.values(state.courses || {}).filter((c) => !c.deletedAt && !c.archivedAt);

  const applyItems = useCallback(async (feed, items) => {
    const store = loadItems();
    const previous = store[feed.id] || [];
    const { items: merged, added, updated, removed } = mergeFeedItems(previous, items);

    const rows = await toAssignments(merged, feed.courseId || null);
    for (const row of rows) {
      // `row` is passed as a field, NOT spread: it carries a `type` of its
      // own and spreading it would overwrite the action's discriminator.
      dispatch({ type: 'UPSERT_ASSIGNMENT', row });
      if (session) outbox.enqueue('upsert_assignment', row);
    }

    // A UID that vanished from the feed is withdrawn upstream, so its row goes
    // too. Only reachable on a SUCCESSFUL fetch — see refreshFeed's contract.
    if (removed > 0) {
      const goneUids = previous.filter((p) => !merged.some((m) => m.uid === p.uid));
      const goneRows = await toAssignments(goneUids, feed.courseId || null);
      for (const row of goneRows) {
        dispatch({ type: 'DELETE_ASSIGNMENT', id: row.id });
        if (session) outbox.enqueue('delete_assignment', { id: row.id });
      }
    }

    writeJson(ITEMS_KEY, { ...store, [feed.id]: merged });
    return { added, updated, removed, total: merged.length };
  }, [dispatch, session]);

  const doRefresh = useCallback(async (feed, { quiet = false } = {}) => {
    setBusy(feed.id);
    setErr('');
    try {
      const res = await refreshFeed(feed);
      if (!res.ok) {
        updateFeed(feed.id, { lastError: res.code, lastFetchedAt: feed.lastFetchedAt });
        setFeeds(loadFeeds());
        // Every failure code gets its own sentence. "Something went wrong"
        // is not actionable; "your browser will not allow this, use the
        // Android app" is.
        if (!quiet) showFlash(t(`feed.err.${res.code}`, t('feed.err.network')));
        return;
      }
      const counts = await applyItems(feed, res.items);
      updateFeed(feed.id, {
        lastFetchedAt: new Date().toISOString(),
        lastError: null,
        itemCount: counts.total,
        label: feed.label || res.name || null,
      });
      setFeeds(loadFeeds());
      if (!quiet) showFlash(t('feed.synced', { added: counts.added, updated: counts.updated }));
    } finally {
      setBusy(null);
    }
  }, [applyItems, showFlash, t]);

  // Poll on mount, quietly, for anything past its cadence. Quiet because this
  // runs without the user asking: a flash saying "0 added" every time they
  // open Settings would be noise, and a flash reporting a network error for a
  // background fetch they did not request would be alarming rather than
  // useful. The error is still recorded and shown on the row.
  useEffect(() => {
    if (!open) return;
    const due = loadFeeds().filter((f) => isDue(f));
    if (!due.length) return;
    let cancelled = false;
    (async () => {
      for (const feed of due) {
        if (cancelled) return;
        await doRefresh(feed, { quiet: true });
      }
    })();
    return () => { cancelled = true; };
  }, [open, doRefresh]);

  const onAdd = async () => {
    setErr('');
    const res = addFeed({ url, label: null });
    if (!res.ok) { setErr(t(`feed.err.${res.error}`)); return; }
    const feed = { ...res.feed, courseId: courseId || null };
    updateFeed(feed.id, { courseId: feed.courseId });
    setUrl('');
    setCourseId('');
    setFeeds(loadFeeds());
    await doRefresh(feed);
  };

  const onRemove = async (feed) => {
    // The rows this feed created go with it. Leaving them would be worse than
    // either alternative: the user unsubscribed, and a hundred orphaned
    // deadlines they cannot trace back to anything is not a kindness.
    const store = loadItems();
    const mine = store[feed.id] || [];
    const rows = await toAssignments(mine, feed.courseId || null);
    for (const row of rows) {
      dispatch({ type: 'DELETE_ASSIGNMENT', id: row.id });
      if (session) outbox.enqueue('delete_assignment', { id: row.id });
    }
    const next = { ...store };
    delete next[feed.id];
    writeJson(ITEMS_KEY, next);
    removeFeed(feed.id);
    setFeeds(loadFeeds());
    showFlash(t('feed.removed', { n: rows.length }));
  };

  return (
    <div className="sv2-section">
      <button
        type="button"
        className="sv2-disclosure"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="sv2-section-title" style={{ marginBottom: 0 }}>{t('feed.title')}</span>
        <span className="sv2-disclosure-chev" aria-hidden="true">{open ? '▾' : '▸'}</span>
      </button>

      {open && (
        <div className="sv2-disclosure-body">
          <p className="sv2-note" style={{ marginTop: 0 }}>{t('feed.help')}</p>
          {/* The limits, stated before the input rather than after a failure. */}
          <p className="sv2-note">{t('feed.limits')}</p>

          {feeds.map((feed) => (
            <div key={feed.id} className="feed-row">
              <div className="feed-row-main">
                <div className="feed-row-name">{feed.label || describeFeedUrl(feed.url)}</div>
                <div className="feed-row-meta">
                  {/* Host only. The PATH of a feed URL is the secret — it is
                      what makes it a capability URL — so it is never shown,
                      not even to the person who pasted it. */}
                  {describeFeedUrl(feed.url)}
                  {feed.itemCount > 0 && ` · ${t('feed.itemCount', { count: feed.itemCount })}`}
                </div>
                {feed.lastError && (
                  <div className="feed-row-err">{t(`feed.err.${feed.lastError}`, t('feed.err.network'))}</div>
                )}
              </div>
              <button
                className="btn-outline btn-sm"
                onClick={() => doRefresh(feed)}
                disabled={busy === feed.id}
              >
                {busy === feed.id ? t('feed.syncing') : t('feed.refresh')}
              </button>
              <button className="btn-danger-text" onClick={() => onRemove(feed)} aria-label={t('feed.remove')}>
                ×
              </button>
            </div>
          ))}

          <div className="input-group">
            <div className="input-label">{t('feed.urlLabel')}</div>
            <input
              type="url"
              inputMode="url"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setErr(''); }}
              placeholder="https://…"
              autoCapitalize="off"
              autoCorrect="off"
              spellCheck={false}
            />
          </div>
          {courses.length > 0 && (
            <div className="input-group">
              <div className="input-label">{t('feed.courseLabel')}</div>
              <select value={courseId} onChange={(e) => setCourseId(e.target.value)}>
                <option value="">{t('feed.noCourse')}</option>
                {courses.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
          )}
          {err && <div className="feed-row-err">{err}</div>}
          <div className="sv2-action">
            <button className="btn" onClick={onAdd} disabled={!url.trim() || busy !== null}>
              {t('feed.subscribe')}
            </button>
          </div>
          <p className="sv2-note">{t('feed.deviceOnly')}</p>
        </div>
      )}
    </div>
  );
}
