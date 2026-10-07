// v1.17 (limecore#17) — what Settings > Feedback says happened to a report.
//
// Positive states only, on purpose. At tens of thousands of users most reports
// will never be triaged one by one, and a "Received" or "Declined" label that
// never moves tells people their feedback went nowhere, which stops them
// sending it. So a report reads "Planned" or "Shipped" when it earned that,
// and plain "Sent" in every other case, including `declined` and anything the
// database adds later. The copy promises no reply anywhere.
//
// If triage ever falls far enough behind that even this misleads, set
// SHOW_FEEDBACK_STATUS to false: the list stays, the status labels go.

export const SHOW_FEEDBACK_STATUS = true;

/**
 * @param {{ status?: string, shipped_in?: string | null }} row
 * @returns {null | { key: 'sent' | 'planned' | 'shipped' | 'shippedIn', version?: string }}
 */
export function feedbackStatus(row, show = SHOW_FEEDBACK_STATUS) {
  if (!show) return null;
  if (row?.status === 'planned') return { key: 'planned' };
  if (row?.status === 'shipped') {
    const v = typeof row.shipped_in === 'string' ? row.shipped_in.trim() : '';
    // Triage writes "1.17" or "v1.17"; either reads as "v1.17".
    return v ? { key: 'shippedIn', version: /^v/i.test(v) ? v : `v${v}` } : { key: 'shipped' };
  }
  return { key: 'sent' };
}
