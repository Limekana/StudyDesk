import { defineConfig } from 'vitest/config';

// Separate from `vite.config.js` on purpose: that file carries the Capacitor
// and Electron build shape, none of which a Node-side unit run needs. Tests
// here are pure logic only (v1.16, limecore#11) — no jsdom, no component
// rendering.
export default defineConfig({
  test: {
    environment: 'node',
    // `test/` holds tests for code outside `src` (the Electron main process),
    // kept out of `electron/` so electron-builder does not ship them.
    include: ['src/**/*.test.js', 'test/**/*.test.mjs'],
  },
});
