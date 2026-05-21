import adapter from '@sveltejs/adapter-static';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

// Set BASE_PATH at build time, e.g. `BASE_PATH=/sensor-pwa npm run build` for GH Pages.
const base = process.env.BASE_PATH ?? '';

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({
      pages: 'build',
      assets: 'build',
      fallback: 'index.html', // SPA fallback so client routing works offline
      precompress: false,
      strict: true
    }),
    paths: { base },
    serviceWorker: { register: false } // we register our own via vite-plugin-pwa
  }
};

export default config;
