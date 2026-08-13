const fs = require('fs');
const { chromium } = require('playwright');

async function main() {
  console.log('Opening LinkedIn login.');
  console.log('Log in manually, return to this terminal, and press Enter.');

  // No `channel: 'chrome'` here — that requires a system-installed Google Chrome,
  // but the README only has users run `npx playwright install chromium`. Using the
  // same bundled Chromium as linkedin.js keeps setup working with just that command
  // and keeps the saved session consistent with the browser that replays it.
  const browser = await chromium.launch({ headless: false });

  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto('https://www.linkedin.com/login');
  await new Promise((resolve) => process.stdin.once('data', resolve));
  const storage = await context.storageState();
  fs.writeFileSync('./session-linkedin.json', JSON.stringify(storage, null, 2));
  await browser.close();
  console.log('LinkedIn session saved to session-linkedin.json.');
}

main().catch((err) => {
  console.error('Session setup failed:', err.message);
  process.exitCode = 1;
});
