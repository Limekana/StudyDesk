import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import process from 'node:process';

// v1.18.1 (StudyDesk#151): the widget parsed 'YYYY-MM-DD' with new Date(),
// which is UTC midnight. West of UTC that is the previous evening, so an item
// due today read as yesterday and one due tomorrow as "Today". The bug only
// shows off UTC, so this file runs in New York time.
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({}), Capacitor: { getPlatform: () => 'web' } }));
vi.mock('./theme.js', () => ({ resolveWidgetPalette: () => 'light' }));
vi.mock('../i18n', () => ({ default: { language: 'en' } }));

const ORIGINAL_TZ = process.env.TZ;
let whenLabel, rank;
beforeAll(async () => {
  process.env.TZ = 'America/New_York';
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 9, 12, 21, 0)); // 12 Oct, 21:00 local
  ({ whenLabel } = await import('./widgetBridge.js'));
  ({ rankOpenDeadlines: rank } = await import('./dueAt.js'));
});
afterAll(() => {
  vi.useRealTimers();
  if (ORIGINAL_TZ === undefined) delete process.env.TZ;
  else process.env.TZ = ORIGINAL_TZ;
});

describe('widget dates west of UTC', () => {
  it('runs in a zone behind UTC (guards the test itself)', () => {
    expect(new Date().getTimezoneOffset()).toBeGreaterThan(0);
  });

  it('labels today, tomorrow and later by the local calendar', () => {
    expect(whenLabel('2026-10-12', 'en')).toMatchObject({ days: 0, today: true });
    expect(whenLabel('2026-10-13', 'en')).toMatchObject({ days: 1, tomorrow: true });
    expect(whenLabel('2026-10-15', 'en')).toMatchObject({ days: 3, text: 'Oct 15' });
  });

  it('orders by due date and time, exams first on a tie', () => {
    const order = rank(
      [
        { id: 'a-late', title: 'A', dueDate: '2026-10-14' },
        { id: 'a-timed', title: 'B', dueDate: '2026-10-13', dueTime: '09:00' },
        { id: 'a-day', title: 'C', dueDate: '2026-10-13' },
      ],
      [{ id: 'e-day', title: 'E', dueDate: '2026-10-13' }],
    ).map((i) => i.id);
    expect(order).toEqual(['a-timed', 'e-day', 'a-day', 'a-late']);
  });
});
