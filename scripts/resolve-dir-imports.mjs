// A Node resolve hook that understands Vite's directory imports.
//
// `src/lib/dates.js` does `import ... from './i18n'`, meaning
// `./i18n/index.js`. Vite (and every bundler) resolves that; Node's ESM
// loader does not, and throws ERR_UNSUPPORTED_DIR_IMPORT.
//
// This exists so `check-logic.mjs` can import the app's real pure modules
// rather than a copy of them. The alternative — duplicating the functions
// into the test file — would mean the assertions pass while the shipped code
// is broken, which is worse than having no assertions at all.
//
// It also supplies the `with { type: 'json' }` attribute Node requires and
// bundlers do not, for the same reason: `src/i18n/index.js` imports ten
// locale JSON files, and annotating them in the app to satisfy a test would
// be the test dictating source style.
//
// Deliberately NOT a change to the app: rewriting the import to
// `./i18n/index.js` would work everywhere, but the next directory import
// somebody writes would break the gate again. The hook handles the pattern
// rather than one instance of it.

import { existsSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { join } from 'node:path';

export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (err) {
    if (err?.code !== 'ERR_UNSUPPORTED_DIR_IMPORT') throw err;

    // The error carries the resolved directory URL it refused. Try the two
    // filenames a bundler would, in the order a bundler would.
    const dir = fileURLToPath(err.url);
    for (const candidate of ['index.js', 'index.mjs', 'index.jsx']) {
      const full = join(dir, candidate);
      if (existsSync(full)) {
        return nextResolve(pathToFileURL(full).href, context);
      }
    }
    throw err;
  }
}

export async function load(url, context, nextLoad) {
  // Bundlers import JSON without an attribute; Node requires one. Supplying
  // it here keeps the app's import statements as a bundler expects them.
  if (url.endsWith('.json') && context.importAttributes?.type !== 'json') {
    return nextLoad(url, { ...context, importAttributes: { ...context.importAttributes, type: 'json' } });
  }
  return nextLoad(url, context);
}
