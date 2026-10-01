import { chromium } from '@playwright/test';
import { mkdir, readFile } from 'node:fs/promises';
const browser = await chromium.launch();
try {
  const page = await browser.newPage({ viewport: { width: 1024, height: 1024 } });
  const svg = await readFile('public/favicon.svg', 'utf8');
  await page.setContent(
    `<style>html,body{margin:0;background:transparent}svg{width:1024px;height:1024px}</style>${svg}`,
  );
  await mkdir('build', { recursive: true });
  await page.screenshot({ path: 'build/icon.png', omitBackground: true });
} finally {
  await browser.close();
}
