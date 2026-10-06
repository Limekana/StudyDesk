import { describe, it, expect } from 'vitest';
import { callbackErrorMessage } from './authErrors.js';

const t = (key) => `<${key}>`;
const msg = (qs) => callbackErrorMessage(new URLSearchParams(qs), t);

describe('callbackErrorMessage (limecore#37)', () => {
  it('never shows the incoming error text', () => {
    const spoof = 'Your account is locked, contact evil@example.com';
    const out = msg(`error=server_error&error_description=${encodeURIComponent(spoof)}`);
    expect(out).toBe('<auth.errSignInFailed>');
    expect(out).not.toContain('locked');
  });

  it('maps an expired email link', () => {
    expect(msg('error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired'))
      .toBe('<auth.errLinkExpired>');
  });

  it('maps a known auth error code', () => {
    expect(msg('error=access_denied&error_code=over_email_send_rate_limit')).toBe('<auth.errRateLimited>');
  });

  it('falls back to the generic line for a cancel or an unknown code', () => {
    expect(msg('error=access_denied')).toBe('<auth.errSignInFailed>');
    expect(msg('error_description=anything')).toBe('<auth.errSignInFailed>');
    expect(msg('error=x&error_code=__proto__')).toBe('<auth.errSignInFailed>');
  });
});
