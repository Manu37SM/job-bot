const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { execFileSync } = require('child_process');

const CLI = path.join(__dirname, '..', 'cli.js');

function parse(argv) {
  const script = `process.argv = ['node','index.js',${argv.map((a) => JSON.stringify(a)).join(',')}]; console.log(JSON.stringify(require(${JSON.stringify(CLI)}).options));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { encoding: 'utf-8' }));
}

test('no flags means a normal run', () => {
  assert.deepEqual(parse([]), { dryRun: false, limit: null, ignoreCooldown: false, help: false });
});

test('--ignore-cooldown is off unless asked for explicitly', () => {
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

const { effectiveRunBudget } = require('../linkedin');

test('--limit tightens the configured caps and can never raise them', () => {
  const base = { perRun: 8, perDay: 15, lifetime: 500, doneToday: 0, alreadyDone: 291 };
  assert.equal(effectiveRunBudget({ ...base }), 8);
  assert.equal(effectiveRunBudget({ ...base, limit: 3 }), 3);
  assert.equal(effectiveRunBudget({ ...base, limit: 100 }), 8, '--limit must not exceed perRun');
  assert.equal(effectiveRunBudget({ ...base, limit: 999999 }), 8);
});

test('the daily and lifetime ceilings bind regardless of --limit', () => {
  const base = { perRun: 8, perDay: 15, lifetime: 500, doneToday: 0, alreadyDone: 291 };
  assert.equal(effectiveRunBudget({ ...base, doneToday: 14 }), 1);
  assert.equal(effectiveRunBudget({ ...base, doneToday: 15 }), 0);
  assert.equal(
    effectiveRunBudget({ ...base, doneToday: 14, limit: 8 }),
    1,
    'the day cap still wins'
  );
  assert.equal(effectiveRunBudget({ ...base, alreadyDone: 500 }), 0);
});

test('a nonsensical limit floors at zero rather than going negative', () => {
  const base = { perRun: 8, perDay: 15, lifetime: 500, doneToday: 0, alreadyDone: 0 };
  assert.equal(effectiveRunBudget({ ...base, limit: -5 }), 0);
  assert.equal(effectiveRunBudget({ ...base, limit: 0 }), 0);
  assert.equal(
    effectiveRunBudget({ ...base, doneToday: 99 }),
    0,
    'an over-quota day is 0, not negative'
  );
});

test('--limit 0 means zero, not "unset"', () => {
  assert.equal(parse(['--limit', '0']).limit, 0);
  assert.equal(parse(['--limit=0']).limit, 0);
  const { effectiveRunBudget } = require('../linkedin');
  assert.equal(
    effectiveRunBudget({
      perRun: 8,
      perDay: 15,
      lifetime: 500,
      doneToday: 0,
      alreadyDone: 0,
      limit: 0,
    }),
    0
  );
});
