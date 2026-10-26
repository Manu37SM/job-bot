// Runs the suite on a clean checkout (CI), where the private config.js, resume-profile.js and CV
// do not exist and the example files are used instead. Tests listed in test/ci-skip.list assert
// against the maintainer's real personal data and cannot pass here; they still run locally via
// `npm test`. Keep that list shrinking, not growing.
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const skips = fs
  .readFileSync(path.join(__dirname, '..', 'test', 'ci-skip.list'), 'utf8')
  .split(/\r?\n/)
  .map((l) => l.trim())
  .filter(Boolean)
  .map((l) => `--test-skip-pattern=^${escape(l)}$`);

const result = spawnSync(process.execPath, ['--test', ...skips], { stdio: 'inherit' });
process.exit(result.status === null ? 1 : result.status);
