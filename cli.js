// Command-line overrides. Kept in one place so `node index.js --help` is the
// single source of truth for what the flags do.
const args = process.argv.slice(2);

function flag(name) {
  // Single-character names also answer to the conventional short form (-h),
  // which is what anyone types before reaching for --help.
  return args.includes(`--${name}`) || (name.length === 1 && args.includes(`-${name}`));
}

function value(name, fallback = null) {
  const prefixed = args.find((a) => a.startsWith(`--${name}=`));
  if (prefixed) return prefixed.slice(name.length + 3);
  const index = args.indexOf(`--${name}`);
  if (index !== -1 && args[index + 1] && !args[index + 1].startsWith('--')) return args[index + 1];
  return fallback;
}

function number(name, fallback = null) {
  const raw = value(name);
  const parsed = Number(raw);
  return raw != null && Number.isFinite(parsed) ? parsed : fallback;
}

const options = {
  // Walk the entire pipeline — search, pagination, JD reading, shift and fit
  // screening — without opening a single application form. The only way to verify
  // filters and fit rules without spending from a small daily budget, and the only
  // way to test anything at all while the account is in a cooldown.
  dryRun: flag('dry-run') || flag('dryrun'),
  limit: number('limit'),
  // Deliberate override of the post-rate-limit hold. Not a flag to reach for
  // casually — the hold exists because the run after a pause is the dangerous one.
  ignoreCooldown: flag('ignore-cooldown'),
  help: flag('help') || flag('h'),
};

function printHelp() {
  console.log(`
LinkedIn Job Application Bot

  node index.js                 run normally
  node index.js --dry-run       walk the pipeline and report, applying to nothing
  node index.js --limit 3       cap this run at N applications
  node index.js --ignore-cooldown
                                override the hold after a rate limit (think first)
  node index.js --help          this message

Other commands:

  npm run preflight             validate config.js
  npm run audit                 preview every answer the bot would give
  npm run audit -- --log        read back what it has already submitted
  npm run review                rebuild needs-review.md
  npm run compact-log           shrink applications.json (keeps a backup)
`);
}

module.exports = { options, printHelp };
