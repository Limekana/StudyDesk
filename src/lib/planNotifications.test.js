import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

// v1.19 — SD#137: reminders reached an S24 up to 17 minutes late, because no
// schedule asked for allow-while-idle, and the lead one said "in 30 min" when
// it arrived. Every alarm now wakes the phone, and the lead title names the
// block's start time.

const holder = vi.hoisted(() => ({ scheduled: [] }));
vi.mock('@capacitor/local-notifications', () => ({
  LocalNotifications: {
    requestPermissions: async () => ({ display: 'granted' }),
    registerActionTypes: async () => {},
    getPending: async () => ({ notifications: [] }),
    cancel: async () => {},
    schedule: async ({ notifications }) => { holder.scheduled.push(...notifications); },
  },
}));

const { scheduleNotifications, planLeadTitle } = await import('./planNotifications.js');
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
beforeEach(() => { holder.scheduled.length = 0; });

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
