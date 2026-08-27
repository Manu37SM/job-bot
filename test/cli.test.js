const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

// cli.js reads process.argv at require time, so each case runs in its own process.
function parse(argv) {
  const script = `process.argv = ['node','index.js',${argv.map((a) => JSON.stringify(a)).join(',')}]; console.log(JSON.stringify(require(${JSON.stringify(CLI)}).options));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' }));
}

test('no flags means a normal run', () => {
  assert.deepEqual(parse([]), { dryRun: false, limit: null, ignoreCooldown: false, help: false });
});

test('--ignore-cooldown is off unless asked for explicitly', () => {
  // The hold after a rate limit exists because the run *after* a pause is the
  // dangerous one; it must never be bypassed by accident.
  assert.equal(parse([]).ignoreCooldown, false);
  assert.equal(parse(['--dry-run']).ignoreCooldown, false);
  assert.equal(parse(['--ignore-cooldown']).ignoreCooldown, true);
});

test('--dry-run is recognised in both spellings', () => {
  assert.equal(parse(['--dry-run']).dryRun, true);
  assert.equal(parse(['--dryrun']).dryRun, true);
});

test('--limit accepts both space and equals forms', () => {
  assert.equal(parse(['--limit', '3']).limit, 3);
  assert.equal(parse(['--limit=5']).limit, 5);
});

test('a malformed --limit is ignored rather than becoming zero', () => {
  // Parsing "--limit --dry-run" as limit 0 would silently apply to nothing.
  assert.equal(parse(['--limit', '--dry-run']).limit, null);
  assert.equal(parse(['--limit', 'abc']).limit, null);
  assert.equal(parse(['--limit']).limit, null);
});

test('flags combine', () => {
  const options = parse(['--dry-run', '--limit', '2']);
  assert.equal(options.dryRun, true);
  assert.equal(options.limit, 2);
});

test('--help is recognised', () => {
  assert.equal(parse(['--help']).help, true);
  assert.equal(parse(['-h']).help, true);
});
