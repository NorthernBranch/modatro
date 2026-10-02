import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: 'development-csp',
      transformIndexHtml(html) {
        // Vite's local React-refresh preamble is inline in development only.
        return command === 'serve'
          ? html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'")
          : html;
      },
    },
  ],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  test: { include: ['tests/**/*.test.ts', 'tests/**/*.test.mjs'], testTimeout: 15000 },
}));
