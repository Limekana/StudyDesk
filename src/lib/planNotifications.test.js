import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

// v1.19 — SD#137: reminders reached an S24 up to 17 minutes late, because no
// schedule asked for allow-while-idle, and the lead one said "in 30 min" when
// it arrived. Every alarm now wakes the phone, and the lead title names the
// block's start time.

// A stand-in for the plugin that keeps what is pending, as Android does: a
// cancel removes by id, a schedule adds or replaces by id. `getPending` hands
// back `schedule.at` as Android does, a java.util.Date's toString() in a zone
// JS cannot parse, and `extra` unchanged.
const holder = vi.hoisted(() => ({ scheduled: [], cancelled: [], pending: new Map(), actionLabels: [], gate: null, runs: 0, inFlight: 0, overlapped: false }));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    requestPermissions: async () => ({ display: 'granted' }),
    registerActionTypes: async ({ types }) => { holder.actionLabels.push(types[0].actions[0].title); },
    getPending: async () => {
      holder.runs += 1;
      holder.inFlight += 1;
      if (holder.inFlight > 1) holder.overlapped = true;
      if (holder.gate) await holder.gate;
      holder.inFlight -= 1;
      return { notifications: [...holder.pending.values()].map((n) => ({ ...n, schedule: { at: 'Thu Oct 15 09:00:00 HST 2026' } })) };
    },
    cancel: async ({ notifications }) => {
      for (const { id } of notifications) { holder.pending.delete(id); holder.cancelled.push(id); }
    },
    schedule: async ({ notifications }) => {
      holder.scheduled.push(...notifications);
      for (const n of notifications) holder.pending.set(n.id, n);
    },
  },
}));

const { scheduleNotifications, cancelAllNotifications, planLeadTitle, reminderId, buildReminders } = await import('./planNotifications.js');
const { dueReminders } = await import('./webNotify.js');
const { fmtTime } = await import('./dates.js');
const { default: i18n, i18nReady } = await import('../i18n');
const t = i18n.t.bind(i18n);

const DAY = 24 * 60 * 60 * 1000;
const iso = (d) => d.toISOString().slice(0, 10);

/** A local 15:00 two days out: far enough that every reminder is in the future. */
function blockStart() {
  const d = new Date(Date.now() + 2 * DAY);
  d.setHours(15, 0, 0, 0);
  return d;
}

beforeAll(async () => { await i18nReady; });
beforeEach(() => {
  holder.scheduled.length = 0;
  holder.cancelled.length = 0;
  holder.pending.clear();
  holder.gate = null;
  holder.runs = 0;
  holder.inFlight = 0;
  holder.overlapped = false;
});

describe('scheduleNotifications', () => {
  it('schedules every reminder allow-while-idle, so Doze cannot hold it', async () => {
    const start = blockStart();
    const due = iso(new Date(Date.now() + 10 * DAY));
    await scheduleNotifications(
      [{ id: 'e1', title: 'Final', courseId: 'c1', dueDate: due, difficulty: 'easy' }],
      [{ id: 'a1', title: 'Essay', courseId: 'c1', dueDate: due, dueTime: '17:00' }],
      { c1: { name: 'History' } },
      [{ id: 'p1', startsAt: start.toISOString(), subjectId: 'c1' }],
      { lead: 30, atStart: true },
      t,
    );
    // The digest, the exam, the assignment and both plan reminders are all in
    // the batch, so the assertion below covers each kind.
    expect(holder.scheduled.length).toBeGreaterThan(5);
    for (const n of holder.scheduled) {
      expect(n.schedule.allowWhileIdle).toBe(true);
      expect(n.schedule.at).toBeInstanceOf(Date);
    }
  });

  it('titles the lead reminder with the start time, and fires it at the lead', async () => {
    const start = blockStart();
    await scheduleNotifications(
      [], [], {},
      [{ id: 'p1', startsAt: start.toISOString(), title: 'Calculus' }],
      { lead: 30, atStart: false },
      t,
    );
    expect(holder.scheduled).toHaveLength(1);
    const [lead] = holder.scheduled;
    expect(lead.title).toBe('Study block at 15:00');
    expect(lead.title).toContain(fmtTime(start.getTime()));
    expect(lead.body).toBe('Calculus');
    expect(lead.schedule.at.getTime()).toBe(start.getTime() - 30 * 60 * 1000);
  });
});

describe('lead reminder wording', () => {
  it('the web loop says the same thing as Android', () => {
    const start = blockStart().getTime();
    const labels = { fallback: 'x', now: 'now', soon: (at) => planLeadTitle(t, at) };
    const [r] = dueReminders([{ id: 'p1', startsAt: new Date(start).toISOString() }],
      { lead: 30 }, {}, start - 30 * 60_000, labels);
    expect(r.title).toBe('Study block at 15:00');
  });

  it('every locale has the key, with the same placeholder', () => {
    const dir = new URL('../i18n/locales/', import.meta.url);
    const files = readdirSync(dir).filter((f) => f.endsWith('.json'));
    expect(files.length).toBeGreaterThanOrEqual(10);
    for (const f of files) {
      const { notif } = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      expect(notif.planLeadTitle, f).toMatch(/\{\{time\}\}/);
      expect(notif.planLeadTitle, f).not.toMatch(/\{\{n\}\}/);
      expect(notif.planSoonTitle, f).toBeUndefined();
    }
  });
});

// v1.18.1 (StudyDesk#138) — IDs were positions in the batch and every run
// cancelled and re-sent everything, and runs overlapped. The plugin dismisses
// a shown notification whose ID it reuses, so each pull cleared unread
// reminders, and an interleaved run could leave an old alarm in place.
describe('rescheduling', () => {
  const state = () => {
    const due = iso(new Date(Date.now() + 10 * DAY));
    return [
      [{ id: 'e1', title: 'Final', courseId: 'c1', dueDate: due, difficulty: 'easy' }],
      [{ id: 'a1', title: 'Essay', courseId: 'c1', dueDate: due }],
      { c1: { name: 'History' } },
      [{ id: 'p1', startsAt: blockStart().toISOString(), subjectId: 'c1' }],
      { lead: 30, atStart: true },
      t,
    ];
  };

  it('gives each reminder an ID from what it is about, the same every time', () => {
    expect(reminderId('exam-day:e1')).toBe(reminderId('exam-day:e1'));
    expect(reminderId('exam-day:e1')).not.toBe(reminderId('exam-day:e2'));
    for (const k of ['digest:2026-10-15', 'plan-lead:p1', 'x'.repeat(500)]) {
      const id = reminderId(k);
      expect(Number.isInteger(id) && id >= 100000 && id <= 2 ** 31 - 1).toBe(true);
    }
  });

  it('leaves unchanged reminders alone: a second run with the same state sends and cancels nothing', async () => {
    await scheduleNotifications(...state());
    const first = holder.scheduled.length;
    expect(first).toBeGreaterThan(5);
    await scheduleNotifications(...state());
    expect(holder.scheduled.length).toBe(first);
    expect(holder.cancelled).toEqual([]);
  });

  it('re-sends only the reminder that changed', async () => {
    const s = state();
    await scheduleNotifications(...s);
    const before = holder.scheduled.length;
    const moved = new Date(blockStart().getTime() + 60 * 60 * 1000);
    s[3] = [{ ...s[3][0], startsAt: moved.toISOString() }];
    await scheduleNotifications(...s);
    const resent = holder.scheduled.slice(before);
    expect(resent).toHaveLength(2); // the plan's lead and at-start reminders
    expect(resent.every((n) => n.body === 'History')).toBe(true);
    expect(holder.cancelled).toHaveLength(2);
  });

  it('runs one at a time, and only the newest of the runs that queued up', async () => {
    let open;
    holder.gate = new Promise((r) => { open = r; });
    const a = scheduleNotifications([], [], {}, [], { lead: 30 }, t);
    const s = state();
    const b = scheduleNotifications(s[0], [], s[2], [], {}, t); // superseded by c
    const c = scheduleNotifications(...s);
    open();
    holder.gate = null;
    await Promise.all([a, b, c]);
    // a ran, b was replaced by c before it started, c ran after a finished.
    expect(holder.runs).toBe(2);
    expect(holder.overlapped).toBe(false);
    expect(holder.scheduled.some((n) => n.extra?.view === 'timer')).toBe(true);
  });

  it('a switch-off waits for a reschedule in flight, so nothing is left pending', async () => {
    let open;
    holder.gate = new Promise((r) => { open = r; });
    const run = scheduleNotifications(...state());
    const off = cancelAllNotifications();
    open();
    holder.gate = null;
    await Promise.all([run, off]);
    expect(holder.pending.size).toBe(0);
  });
});

// v1.18.1 (StudyDesk#141) — the digest, exam and assignment titles, and the
// "Mark done" button, were English in every language.
describe('reminder language', () => {
  it('titles and the Mark done button follow the app language', async () => {
    // Locales other than English load on demand; this is what loadLanguage does.
    const { default: de } = await import('../i18n/locales/de.json');
    if (!i18n.hasResourceBundle('de', 'translation')) i18n.addResourceBundle('de', 'translation', de);
    await i18n.changeLanguage('de');
    try {
      const due = iso(new Date(Date.now() + 10 * DAY));
      await scheduleNotifications(
        [{ id: 'e1', title: 'Final', courseId: 'c1', dueDate: due, difficulty: 'easy' }],
        [{ id: 'a1', title: 'Essay', courseId: 'c1', dueDate: due }],
        { c1: { name: 'History' } }, [], {}, t,
      );
      const titles = holder.scheduled.map((n) => n.title);
      expect(titles).toContain(i18n.t('notif.digestTitle'));
      expect(titles).toContain('📋 Morgen fällig');
      expect(titles.some((x) => /Due|Exam|Time to start|Next Up/.test(x))).toBe(false);
      expect(holder.actionLabels.at(-1)).toBe('Als erledigt markieren');
    } finally {
      await i18n.changeLanguage('en');
    }
  });

  it('every locale has every reminder title', () => {
    const dir = new URL('../i18n/locales/', import.meta.url);
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.json'))) {
      const { notif } = JSON.parse(readFileSync(new URL(f, dir), 'utf8'));
      for (const k of ['digestTitle', 'examStartTitle', 'examStartBody_other', 'examSoonTitle', 'examTodayTitle', 'dueTomorrowTitle', 'dueTodayTitle', 'markDone']) {
        expect(notif[k], `${f} notif.${k}`).toBeTruthy();
      }
      expect(notif.examStartBody_other, f).toMatch(/\{\{label\}\}/);
      expect(notif.examStartBody_other, f).toMatch(/\{\{count\}\}/);
    }
  });
});

// Review follow-ups to the StudyDesk#138 fix.
describe('rescheduling, edge cases', () => {
  it('the digest keeps its IDs and times as the days roll forward past midnight', () => {
    const due = iso(new Date(Date.now() + 40 * DAY));
    const args = [[{ id: 'e1', title: 'Final', dueDate: due }], [], {}, [], {}, t];
    const evening = new Date(); evening.setHours(23, 0, 0, 0);
    const morning = new Date(evening.getTime() + 2 * 60 * 60 * 1000); // 01:00 next day
    const byId = (notes) => new Map(notes.filter((n) => n.title === t('notif.digestTitle')).map((n) => [n.id, n.extra.rk]));
    const before = byId(buildReminders(...args, evening.getTime()));
    const after = byId(buildReminders(...args, morning.getTime()));
    // Everything after the next 09:00 is the same reminder, same fingerprint.
    const shared = [...after.keys()].filter((id) => before.has(id));
    expect(shared.length).toBeGreaterThanOrEqual(28);
    for (const id of shared) expect(after.get(id)).toBe(before.get(id));
  });

  it('a reminder whose time has just come but has not fired yet is left to fire', async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    await scheduleNotifications([], [], {}, [{ id: 'p1', startsAt: soon.toISOString(), title: 'Calc' }], { atStart: true }, t);
    expect(holder.pending.size).toBe(1);
    // Its time passes before the alarm fires; the next run no longer lists it.
    const [only] = holder.pending.values();
    only.extra.ra = Date.now() - 60 * 1000;
    await scheduleNotifications([], [], {}, [], { atStart: true }, t);
    expect(holder.cancelled).toEqual([]);
  });

  it('one long past is cleared', async () => {
    const soon = new Date(Date.now() + 60 * 60 * 1000);
    await scheduleNotifications([], [], {}, [{ id: 'p1', startsAt: soon.toISOString(), title: 'Calc' }], { atStart: true }, t);
    const [only] = holder.pending.values();
    only.extra.ra = Date.now() - 60 * 60 * 1000;
    await scheduleNotifications([], [], {}, [], { atStart: true }, t);
    expect(holder.cancelled).toHaveLength(1);
  });
});

// StudyDesk#165 — every reminder carries `extra.sa`, when it stops being true.
// The patched plugin (patches/) drops an overdue one past that after a reboot
// instead of firing it late, and fires the ones still true.
describe('stale-after cutoff', () => {
  const endOfDay = (ms) => { const e = new Date(ms); e.setHours(23, 59, 59, 999); return e.getTime(); };
  const notes = () => {
    const start = blockStart();
    const due = iso(new Date(Date.now() + 5 * DAY));
    return {
      start,
      list: buildReminders(
        [{ id: 'e1', title: 'Final', dueDate: due }],
        [{ id: 'a1', title: 'Essay', dueDate: due, dueTime: '17:00' }, { id: 'a2', title: 'Lab', dueDate: due }],
        {},
        [{ id: 'p1', title: 'Block', startsAt: start.toISOString() }],
        { lead: 30, atStart: true },
        t,
      ),
    };
  };
  const byTitle = (list, key) => list.filter((n) => n.title === t(key));

  it('every reminder has one, never before it fires, and no stray field reaches the plugin', () => {
    const { list } = notes();
    expect(list.length).toBeGreaterThan(5);
    for (const n of list) {
      expect(Number.isFinite(n.extra.sa)).toBe(true);
      expect(n.extra.sa).toBeGreaterThanOrEqual(n.schedule.at.getTime());
      expect('staleAt' in n).toBe(false);
    }
  });

  it('day reminders stay true to the end of their day', () => {
    const { list } = notes();
    for (const key of ['notif.examTodayTitle', 'notif.digestTitle', 'notif.dueTomorrowTitle']) {
      const found = byTitle(list, key);
      expect(found.length).toBeGreaterThan(0);
      for (const n of found) expect(n.extra.sa).toBe(endOfDay(n.schedule.at.getTime()));
    }
  });

  it('due-today lasts until the deadline: its time, or 23:59 without one', () => {
    const { list } = notes();
    const [essay, lab] = ['Essay', 'Lab'].map((w) => byTitle(list, 'notif.dueTodayTitle').find((n) => n.body.startsWith(w)));
    const deadline = new Date(essay.schedule.at.getTime()); deadline.setHours(17, 0, 0, 0);
    expect(essay.extra.sa).toBe(deadline.getTime());
    const lastMinute = new Date(lab.schedule.at.getTime()); lastMinute.setHours(23, 59, 0, 0); // dueMoment's END_OF_DAY
    expect(lab.extra.sa).toBe(lastMinute.getTime());
  });

  it('a plan lead reminder ends when the block starts; the at-start one 15 minutes after', () => {
    const { list, start } = notes();
    const lead = list.find((n) => n.title === planLeadTitle(t, start.getTime()));
    const now = byTitle(list, 'notif.planNowTitle')[0];
    expect(lead.extra.sa).toBe(start.getTime());
    expect(now.extra.sa).toBe(start.getTime() + 15 * 60 * 1000);
  });
});
