// v1.17 (Limekana/limecore#33) — which GitHub release pages the desktop update
// check may trust.
//
// The repos are moving from the personal account to the org. GitHub forwards
// the API call after a transfer, but the `html_url` it returns names the NEW
// owner, so accepting only the owner written into `repo` would reject every
// release once the repo moves, and installs would stop seeing updates without
// a word. Both owners are ours. This ships a full release cycle before any
// transfer, so installs already carry it when the move happens.
//
// Kept apart from update-check.cjs so it can be tested without Electron: that
// module requires `electron` at load, which a Node-side test run cannot.
'use strict';

const OWNERS = ['Limekana', 'Limecore-Studio'];

/** Release-page prefixes `html_url` may start with, lower-cased: this repo's
 *  name under its own owner and under every owner in OWNERS. */
function releasePagePrefixes(repo) {
  const [owner, name] = String(repo).split('/');
  return [...new Set([owner, ...OWNERS])].map(
    (o) => `https://github.com/${o}/${name}/releases/`.toLowerCase(),
  );
}

/** True when `url` is a release page of this repo under one of our owners.
 *  GitHub's own casing varies, so the comparison ignores case. */
function isReleasePage(url, repo) {
  if (typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return releasePagePrefixes(repo).some((p) => u.startsWith(p));
}

module.exports = { OWNERS, isReleasePage };
