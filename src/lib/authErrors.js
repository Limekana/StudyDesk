// v1.8 / ACT-2 — translated copy for Supabase auth failures.
//
// `error.message` off signInWithPassword / signUp / exchangeCodeForSession is
// server-supplied and always English, so translating the gate's own literals
// isn't enough: the one string a user sees *after* something goes wrong would
// still come back in English.
//
// We map the handful of codes that actually show up on the gate and fall
// through to the raw message for everything else. Swallowing the unmapped tail
// behind a generic "something went wrong" would cost more than the English
// costs — an untranslated but accurate message still tells the user (or Emil,
// reading a bug report) what happened.
//
// supabase-js >=2.100 sets a stable `code` on AuthError; the message-substring
// arm is a fallback for older payloads and for errors raised as plain Error
// (e.g. the network failures fetch throws before Supabase sees them).

/** Supabase auth error codes -> `auth.*` i18n keys. */
const CODE_KEYS = {
  invalid_credentials: 'auth.errInvalidCredentials',
  invalid_grant: 'auth.errInvalidCredentials',
  user_already_exists: 'auth.errAlreadyRegistered',
  email_exists: 'auth.errAlreadyRegistered',
  weak_password: 'auth.errWeakPassword',
  email_not_confirmed: 'auth.errEmailNotConfirmed',
  over_request_rate_limit: 'auth.errRateLimited',
  over_email_send_rate_limit: 'auth.errRateLimited',
};

/** Lower-cased message fragments -> `auth.*` i18n keys, for code-less errors. */
const MESSAGE_KEYS = [
  ['invalid login credentials', 'auth.errInvalidCredentials'],
  ['already registered', 'auth.errAlreadyRegistered'],
  ['already been registered', 'auth.errAlreadyRegistered'],
  ['user already exists', 'auth.errAlreadyRegistered'],
  ['password should be', 'auth.errWeakPassword'],
  ['weak password', 'auth.errWeakPassword'],
  ['email not confirmed', 'auth.errEmailNotConfirmed'],
  ['rate limit', 'auth.errRateLimited'],
  ['too many requests', 'auth.errRateLimited'],
  ['failed to fetch', 'auth.errNetwork'],
  ['network request failed', 'auth.errNetwork'],
  ['networkerror', 'auth.errNetwork'],
];

/**
 * Translate a Supabase auth error, falling back to its raw (English) message.
 *
 * @param {{code?: string, message?: string} | null | undefined} err
 * @param {(key: string) => string} t
 * @param {string} fallbackKey i18n key used when the error carries no message
 * @returns {string}
 */
export function translateAuthError(err, t, fallbackKey = 'auth.errGeneric') {
  if (!err) return t(fallbackKey);

  const key = err.code ? CODE_KEYS[err.code] : undefined;
  if (key) return t(key);

  const message = err.message ?? '';
  const haystack = message.toLowerCase();
  const matched = MESSAGE_KEYS.find(([fragment]) => haystack.includes(fragment));
  if (matched) return t(matched[1]);

  // Unmapped — surface the server's own wording rather than hiding it.
  return message || t(fallbackKey);
}
