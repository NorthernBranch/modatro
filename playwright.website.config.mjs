import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: 'website.spec.ts',
  workers: 1,
  use: { baseURL: 'http://127.0.0.1:5174', viewport: { width: 1320, height: 900 } },
  webServer: {
    command: 'node node_modules/vite/bin/vite.js website --host 127.0.0.1 --port 5174 --strictPort',
    url: 'http://127.0.0.1:5174',
    reuseExistingServer: false,
  },
});
