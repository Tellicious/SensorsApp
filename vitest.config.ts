import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Node environment is enough — we're testing pure DSP / utility functions.
    // Tests that need the DOM should `// @vitest-environment jsdom` at the top.
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globals: false,
    reporters: 'default'
  },
  resolve: {
    // Mirror SvelteKit's $lib alias so tests can import from $lib/dsp/... etc.
    alias: {
      $lib: new URL('./src/lib', import.meta.url).pathname
    }
  }
});
