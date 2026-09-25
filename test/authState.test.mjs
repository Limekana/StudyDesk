import { describe, it, expect } from 'vitest';
import { createAuthState, STATE_TTL_MS } from '../electron/authState.cjs';

// v1.16 (limecore#3). The desktop loopback listener's OAuth `state` check.
// Lives outside `src/` and `electron/` on purpose: `tsc -b` only covers `src`,
// and electron-builder packages all of `electron/**`, so a test file there
// would ship inside the desktop installer.

const REDIRECT = 'http://127.0.0.1:51837/callback';

// The shape supabase-js builds in `_getUrlForProvider`:
// `redirect_to=${encodeURIComponent(redirectTo)}`, plus the PKCE challenge.
function providerUrl(redirect = REDIRECT, extra = '') {
  return (
    'https://hkktorzhaqnfqsnlstda.supabase.co/auth/v1/authorize?provider=google' +
    `&redirect_to=${encodeURIComponent(redirect)}` +
    '&code_challenge=Zx9_abc-DEF123&code_challenge_method=s256' +
    extra
  );
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms) => (t += ms) };
}

// Pull the nonce back out of the URL `arm` produced, the way the callback will
// carry it: as the `state` parameter of the loopback redirect.
function nonceFrom(armedUrl) {
  const redirect = new URL(armedUrl).searchParams.get('redirect_to');
  return new URL(redirect).searchParams.get('state');
}

describe('arm', () => {
  it('puts a nonce on redirect_to and leaves the rest of the URL alone', () => {
    const s = createAuthState();
    const out = new URL(s.arm(providerUrl(), REDIRECT));
    const before = new URL(providerUrl());

    const back = new URL(out.searchParams.get('redirect_to'));
    expect(back.origin + back.pathname).toBe(REDIRECT);
    expect(back.searchParams.get('state')).toBeTruthy();

    // Every other parameter survives the rewrite — the PKCE challenge above all.
    for (const [k, v] of before.searchParams) {
      if (k !== 'redirect_to') expect(out.searchParams.get(k)).toBe(v);
    }
    expect(out.origin + out.pathname).toBe(before.origin + before.pathname);
  });

  it('mints a URL-safe nonce of at least 256 bits', () => {
    const nonce = nonceFrom(createAuthState().arm(providerUrl(), REDIRECT));
    expect(nonce).toMatch(/^[A-Za-z0-9_-]{43,}$/);
  });

  it('mints a different nonce on every arm', () => {
    const s = createAuthState();
    const a = nonceFrom(s.arm(providerUrl(), REDIRECT));
    const b = nonceFrom(s.arm(providerUrl(), REDIRECT));
    expect(a).not.toBe(b);
  });

  it('refuses a plain-http provider URL', () => {
    const s = createAuthState();
    expect(s.arm(providerUrl().replace('https://', 'http://'), REDIRECT)).toBeNull();
    expect(s.isArmed()).toBe(false);
  });

  it('refuses a URL whose redirect_to is not this listener', () => {
    const s = createAuthState();
    expect(s.arm(providerUrl('http://127.0.0.1:9999/callback'), REDIRECT)).toBeNull();
    expect(s.arm(providerUrl('https://evil.example.com/steal'), REDIRECT)).toBeNull();
    expect(s.isArmed()).toBe(false);
  });

  it('refuses a URL with no redirect_to at all', () => {
    const s = createAuthState();
    expect(s.arm('https://example.com/authorize?provider=google', REDIRECT)).toBeNull();
  });

  it('refuses when the listener never bound (no redirect URI)', () => {
    const s = createAuthState();
    expect(s.arm(providerUrl(), null)).toBeNull();
    expect(s.arm(providerUrl(), '')).toBeNull();
  });

  it('refuses garbage without throwing', () => {
    const s = createAuthState();
    expect(s.arm('not a url', REDIRECT)).toBeNull();
    expect(s.arm(undefined, REDIRECT)).toBeNull();
    expect(s.arm(42, REDIRECT)).toBeNull();
  });
});

describe('check', () => {
  it('accepts the matching nonce exactly once', () => {
    const s = createAuthState();
    const nonce = nonceFrom(s.arm(providerUrl(), REDIRECT));
    expect(s.check(nonce)).toBe('ok');
    // Consumed: a replay of the same callback is now unsolicited.
    expect(s.check(nonce)).toBe('none');
  });

  it('reports "none" when no sign-in was started', () => {
    expect(createAuthState().check('anything')).toBe('none');
    expect(createAuthState().check(null)).toBe('none');
  });

  it('rejects a wrong nonce and keeps the real sign-in armed', () => {
    // The property the old boolean lacked: a local process that reaches the
    // listener first can no longer cancel — or complete — the user's sign-in.
    const s = createAuthState();
    const nonce = nonceFrom(s.arm(providerUrl(), REDIRECT));
    expect(s.check('attacker-guess')).toBe('mismatch');
    expect(s.isArmed()).toBe(true);
    expect(s.check(nonce)).toBe('ok');
  });

  it('rejects a callback with no state, as every pre-1.16 URL would carry', () => {
    const s = createAuthState();
    const nonce = nonceFrom(s.arm(providerUrl(), REDIRECT));
    expect(s.check(null)).toBe('mismatch');
    expect(s.check(undefined)).toBe('mismatch');
    expect(s.check(nonce)).toBe('ok');
  });

  it('rejects a nonce that differs only in length', () => {
    const s = createAuthState({ newNonce: () => 'abcdef' });
    s.arm(providerUrl(), REDIRECT);
    expect(s.check('abcde')).toBe('mismatch');
    expect(s.check('abcdefg')).toBe('mismatch');
    expect(s.check('abcdef')).toBe('ok');
  });

  it('only the latest arm can finish: re-arming invalidates the earlier tab', () => {
    const s = createAuthState();
    const first = nonceFrom(s.arm(providerUrl(), REDIRECT));
    const second = nonceFrom(s.arm(providerUrl(), REDIRECT));
    expect(s.check(first)).toBe('mismatch');
    expect(s.check(second)).toBe('ok');
  });

  it('expires after the TTL and clears the pending sign-in', () => {
    const c = clock();
    const s = createAuthState({ now: c.now });
    const nonce = nonceFrom(s.arm(providerUrl(), REDIRECT));
    c.advance(STATE_TTL_MS + 1);
    expect(s.check(nonce)).toBe('expired');
    expect(s.isArmed()).toBe(false);
  });

  it('still accepts a callback exactly at the TTL boundary', () => {
    const c = clock();
    const s = createAuthState({ now: c.now });
    const nonce = nonceFrom(s.arm(providerUrl(), REDIRECT));
    c.advance(STATE_TTL_MS);
    expect(s.check(nonce)).toBe('ok');
  });

  it('keeps the TTL at ten minutes', () => {
    // Google's consent screen plus a 2FA prompt plus a password manager fits;
    // an abandoned attempt does not stay armed for the rest of the day.
    expect(STATE_TTL_MS).toBe(10 * 60 * 1000);
  });
});

describe('disarm', () => {
  it('cancels a pending sign-in, as when the browser could not be opened', () => {
    const s = createAuthState();
    const nonce = nonceFrom(s.arm(providerUrl(), REDIRECT));
    s.disarm();
    expect(s.check(nonce)).toBe('none');
  });
});

describe('the callback URL GoTrue will produce', () => {
  it('carries the nonce as `state` next to the code GoTrue appends', () => {
    // Verified against the live project 2026-09-25: GoTrue keeps the query
    // string on redirect_to and appends its own parameters after it. This
    // replays that shape and feeds it through the check the listener runs.
    const s = createAuthState();
    const armed = s.arm(providerUrl(), REDIRECT);
    const redirect = new URL(armed).searchParams.get('redirect_to');
    const callback = new URL(`${redirect}&code=some-auth-code`);

    expect(callback.pathname).toBe('/callback');
    expect(callback.searchParams.get('code')).toBe('some-auth-code');
    expect(s.check(callback.searchParams.get('state'))).toBe('ok');
  });
});
