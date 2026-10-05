import { describe, it, expect } from 'vitest';
import { feedbackStatus } from './feedbackStatus.js';

describe('feedbackStatus (limecore#17)', () => {
  it('shows only positive states; everything else reads "Sent"', () => {
    expect(feedbackStatus({ status: 'new' })).toEqual({ key: 'sent' });
    expect(feedbackStatus({ status: 'declined' })).toEqual({ key: 'sent' });
    expect(feedbackStatus({ status: 'something-new' })).toEqual({ key: 'sent' });
    expect(feedbackStatus({})).toEqual({ key: 'sent' });
    expect(feedbackStatus({ status: 'planned' })).toEqual({ key: 'planned' });
  });

  it('says which version shipped it when triage recorded one', () => {
    expect(feedbackStatus({ status: 'shipped', shipped_in: '1.17' })).toEqual({ key: 'shippedIn', version: 'v1.17' });
    expect(feedbackStatus({ status: 'shipped', shipped_in: 'v1.17.1' })).toEqual({ key: 'shippedIn', version: 'v1.17.1' });
    expect(feedbackStatus({ status: 'shipped', shipped_in: null })).toEqual({ key: 'shipped' });
    expect(feedbackStatus({ status: 'shipped', shipped_in: '  ' })).toEqual({ key: 'shipped' });
    // Before the migration the column is not selected at all.
    expect(feedbackStatus({ status: 'shipped' })).toEqual({ key: 'shipped' });
  });

  it('the switch turns every label off, the positive ones included', () => {
    expect(feedbackStatus({ status: 'shipped', shipped_in: '1.17' }, false)).toBeNull();
    expect(feedbackStatus({ status: 'new' }, false)).toBeNull();
  });
});
