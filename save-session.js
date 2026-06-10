const fs = require('fs');
const { chromium } = require('playwright');

async function main() {
  console.log('Opening LinkedIn login.');
  console.log('Log in manually, return to this terminal, and press Enter.');

  const browser = await chromium.launch({
    headless: false,
    channel: 'chrome',
    args: ['--no-sandbox'],
  });

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
