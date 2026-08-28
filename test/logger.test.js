const os = require('os');
const path = require('path');
const fs = require('fs');

const SCRATCH = path.join(os.tmpdir(), `job-bot-test-${process.pid}.json`);
process.env.JOB_BOT_LOG = SCRATCH;

const test = require('node:test');
const assert = require('node:assert/strict');
const logger = require('../logger');

function reset(entries = []) {
  fs.writeFileSync(SCRATCH, JSON.stringify(entries, null, 2));
}

test.after(() => {
  for (const f of [SCRATCH, `${SCRATCH}.tmp`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

const job = (over = {}) => ({
  jobId: '900',
  title: 'Backend Engineer',
  company: 'Acme',
  platform: 'LinkedIn',
  link: 'https://www.linkedin.com/jobs/view/900',
  ...over,
});

test('a job with no history is always worth attempting', () => {
  reset();
  assert.equal(logger.shouldSkipJob('900'), null);
});

test('a transient failure is retried on the next run', () => {
  reset();
  logger.recordApplication(job({ status: 'failed', code: 'timeout', reason: 'slow' }));
  assert.equal(logger.shouldSkipJob('900'), null);
});

test('a deterministic failure is parked while the answers are unchanged', () => {
  reset();
  logger.recordApplication(
    job({ status: 'failed', code: 'unanswerable', reason: 'No answer for: Years of Rust?' })
  );
  const skip = logger.shouldSkipJob('900');
  assert.ok(skip, 'expected the job to be parked');
  assert.match(skip, /answers unchanged/);
});

test('editing the answer files un-parks a deterministic failure', () => {
  reset([
    {
      ...job(),
      status: 'failed',
      code: 'unanswerable',
      reason: 'No answer for: Years of Rust?',
      answersHash: 'stale-hash-from-before-the-edit',
      appliedAt: new Date().toISOString(),
    },
  ]);
  assert.equal(logger.shouldSkipJob('900'), null);
});

test('a job is set aside after the attempt limit', () => {
  reset();
  for (let i = 0; i < logger.MAX_FAILED_ATTEMPTS; i++) {
    logger.recordApplication(job({ status: 'failed', code: 'timeout' }));
  }
  const skip = logger.shouldSkipJob('900');
  assert.ok(skip);
  assert.match(skip, /set aside/);
});

test('repeat skips collapse into one row with a counter', () => {
  reset();
  for (let i = 0; i < 5; i++) {
    logger.recordApplication(job({ status: 'skipped', reason: 'already applied' }));
  }
  const rows = logger.loadLog().filter((e) => e.status === 'skipped');
  assert.equal(rows.length, 1, 'five sightings must not write five rows');
  assert.equal(rows[0].seenCount, 5);
});

test('applied entries are never collapsed', () => {
  reset();
  logger.recordApplication(job({ jobId: '1', status: 'applied' }));
  logger.recordApplication(job({ jobId: '2', status: 'applied' }));
  assert.equal(logger.totalAppliedCount('linkedin'), 2);
});

test('a job that later succeeded is no longer an open failure', () => {
  reset();
  logger.recordApplication(job({ status: 'failed', code: 'timeout' }));
  assert.equal(logger.openFailures().length, 1);
  logger.recordApplication(job({ status: 'applied' }));
  assert.equal(logger.openFailures().length, 0);
});

test('alreadyApplied ignores failed and skipped history', () => {
  reset();
  logger.recordApplication(job({ status: 'failed', code: 'timeout' }));
  logger.recordApplication(job({ status: 'skipped' }));
  assert.equal(logger.alreadyApplied('900'), false);
  logger.recordApplication(job({ status: 'applied' }));
  assert.equal(logger.alreadyApplied('900'), true);
});

test('a missing or junk jobId never counts as applied', () => {
  reset([{ jobId: 'undefined', status: 'applied', platform: 'LinkedIn' }]);
  assert.equal(logger.alreadyApplied(undefined), false);
  assert.equal(logger.alreadyApplied('undefined'), false);
  assert.equal(logger.alreadyApplied(null), false);
});

test('compaction collapses old duplicate skips without touching real history', () => {
  const rows = [];
  for (let i = 0; i < 40; i++) {
    rows.push({
      jobId: '5',
      platform: 'LinkedIn',
      status: 'skipped',
      appliedAt: `2026-08-0${(i % 9) + 1}T00:00:00.000Z`,
    });
  }
  rows.push({
    jobId: '6',
    platform: 'LinkedIn',
    status: 'applied',
    appliedAt: '2026-08-10T00:00:00.000Z',
  });
  rows.push({
    jobId: '7',
    platform: 'LinkedIn',
    status: 'failed',
    code: 'timeout',
    appliedAt: '2026-08-11T00:00:00.000Z',
  });
  reset(rows);

  const { log, collapsed, after } = logger.compactLog();
  assert.equal(collapsed, 39);
  assert.equal(after, 3);
  assert.equal(log.filter((e) => e.status === 'applied').length, 1);
  assert.equal(log.filter((e) => e.status === 'failed').length, 1);
  assert.equal(log.find((e) => e.status === 'skipped').seenCount, 40);
});

test('the daily count only counts today, and only this platform', () => {
  const today = new Date().toISOString();
  reset([
    { jobId: '1', platform: 'LinkedIn', status: 'applied', appliedAt: today },
    { jobId: '2', platform: 'LinkedIn', status: 'applied', appliedAt: '2020-01-01T00:00:00.000Z' },
    { jobId: '3', platform: 'Naukri', status: 'applied', appliedAt: today },
  ]);
  assert.equal(logger.appliedTodayCount('linkedin'), 1);
  assert.equal(logger.totalAppliedCount('linkedin'), 2);
});

test('a corrupt log does not read as an empty history', () => {
  reset([
    { jobId: '900', platform: 'LinkedIn', status: 'applied', appliedAt: new Date().toISOString() },
  ]);
  assert.equal(logger.alreadyApplied('900'), true);
  fs.writeFileSync(SCRATCH, '{ this is not json');
  assert.equal(logger.alreadyApplied('900'), true);
});

test('jobs with no extractable id stay distinct in the log', () => {
  reset();
  logger.recordApplication(
    job({ jobId: undefined, title: 'Role A', company: 'Acme', status: 'failed', code: 'timeout' })
  );
  logger.recordApplication(
    job({ jobId: undefined, title: 'Role B', company: 'Globex', status: 'failed', code: 'timeout' })
  );
  const failures = logger.openFailures();
  assert.equal(failures.length, 2, 'two different jobs must not share an entry');
  assert.ok(failures.every((f) => f.idSynthesised));
});

test('repeat skips of an id-less job still collapse, per job', () => {
  reset();
  for (let i = 0; i < 3; i++) {
    logger.recordApplication(
      job({ jobId: null, title: 'Role A', company: 'Acme', status: 'skipped' })
    );
  }
  logger.recordApplication(
    job({ jobId: null, title: 'Role B', company: 'Globex', status: 'skipped' })
  );
  const skipped = logger.loadLog().filter((e) => e.status === 'skipped');
  assert.equal(skipped.length, 2);
  assert.equal(skipped.find((e) => e.title === 'Role A').seenCount, 3);
});

test('a synthetic id never collides with a real one', () => {
  const synthetic = logger.syntheticId('Backend Engineer', 'Acme');
  assert.match(synthetic, /^x:/);
  assert.equal(logger.alreadyApplied(undefined), false);
  assert.notEqual(synthetic, '4451627000');
});

test('a job set aside after the attempt limit gets another chance later', () => {
  const old = new Date(Date.now() - (logger.RETIRE_COOLDOWN_DAYS + 1) * 86400000).toISOString();
  const recent = new Date().toISOString();

  const attempts = (when) =>
    Array.from({ length: logger.MAX_FAILED_ATTEMPTS }, () => ({
      jobId: '900',
      platform: 'LinkedIn',
      status: 'failed',
      code: 'timeout',
      appliedAt: when,
    }));

  reset(attempts(recent));
  assert.match(logger.shouldSkipJob('900'), /set aside/);

  reset(attempts(old));
  assert.equal(logger.shouldSkipJob('900'), null);
});

test('a deterministic failure stays parked regardless of age', () => {
  const old = new Date(Date.now() - 400 * 86400000).toISOString();
  reset([
    {
      jobId: '900',
      platform: 'LinkedIn',
      status: 'failed',
      code: 'unanswerable',
      reason: 'No answer for: Years of Rust?',
      answersHash: logger.answersFingerprint(),
      appliedAt: old,
    },
  ]);
  assert.match(logger.shouldSkipJob('900'), /answers unchanged/);
});

test('two writes in the same millisecond are never confused for one', () => {
  let stale = 0;
  for (let i = 0; i < 200; i++) {
    reset([
      { jobId: '1', status: 'failed', code: 'timeout', appliedAt: '2020-01-01T00:00:00.000Z' },
    ]);
    const first = logger.loadLog()[0].appliedAt;
    reset([
      { jobId: '1', status: 'failed', code: 'timeout', appliedAt: '2026-12-31T00:00:00.000Z' },
    ]);
    const second = logger.loadLog()[0].appliedAt;
    if (first === second) stale++;
  }
  assert.equal(stale, 0, `${stale}/200 reads returned stale data`);
});

test('a write immediately followed by a read reflects the write', () => {
  reset();
  logger.recordApplication(job({ jobId: '77', status: 'applied' }));
  assert.equal(logger.alreadyApplied('77'), true);
  reset();
  assert.equal(logger.alreadyApplied('77'), false, 'an external truncation must be visible');
});
