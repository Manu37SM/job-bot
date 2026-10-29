// Fails if a file holding personal data is tracked by git. This repo is public; config.js,
// resume-profile.js, .env, saved sessions, application history and CVs must stay local.
const { execFileSync } = require('node:child_process');

const PRIVATE = [
  /^\.env$/,
  /^\.env\..+/,
  /^config\.js$/,
  /^resume-profile\.js$/,
  /^session-.*\.json$/,
  /^applications\.json/,
  /^\.bot-state\.json$/,
  /^needs-review\.md$/,
  /^dry-run\.md$/,
  /\.pdf$/i,
];
const ALLOWED = new Set(['.env.example']);

const tracked = execFileSync('git', ['ls-files'], { encoding: 'utf8' })
  .split(/\r?\n/)
  .filter(Boolean);
const leaked = tracked.filter((f) => !ALLOWED.has(f) && PRIVATE.some((re) => re.test(f)));

if (leaked.length) {
  console.error('Private files are tracked by git:\n  ' + leaked.join('\n  '));
  process.exit(1);
}
console.log(`ok: none of ${tracked.length} tracked files are private`);
