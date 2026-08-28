const os = require('os');
const path = require('path');
const fs = require('fs');

const SCRATCH = path.join(os.tmpdir(), `job-bot-card-${process.pid}.json`);
process.env.JOB_BOT_LOG = SCRATCH;

const test = require('node:test');
const assert = require('node:assert/strict');
const { cardDecision, resetRunState } = require('../linkedin');
const config = require('../config');

function seed(rows) {
  fs.writeFileSync(SCRATCH, JSON.stringify(rows));
  resetRunState();
}

test.after(() => {
  for (const f of [SCRATCH, `${SCRATCH}.tmp`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

const row = (over) => ({
  jobId: '111',
  title: 'Backend Engineer',
  company: 'Acme',
  platform: 'LinkedIn',
  appliedAt: new Date().toISOString(),
  ...over,
});

test('an unseen, unapplied, on-target job is opened', () => {
  seed([]);
  assert.deepEqual(cardDecision({ jobId: '111', title: 'Senior Java Developer' }), {
    action: 'open',
  });
});

test('a card with no id falls back to opening the job', () => {
  seed([]);
  assert.deepEqual(cardDecision({ title: 'Senior Java Developer' }), { action: 'open' });
  assert.deepEqual(cardDecision({}), { action: 'open' });
});

test('a job already applied to is skipped without opening, and logged', () => {
  seed([row({ status: 'applied' })]);
  const decision = cardDecision({ jobId: '111', title: 'Backend Engineer' });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.reason, 'already applied');
  assert.equal(decision.log, true);
});

test('a job parked by backoff is skipped without opening', () => {
  seed([
    row({
      status: 'failed',
      code: 'unanswerable',
      reason: 'No answer for: Years of Rust?',
      answersHash: require('../logger').answersFingerprint(),
    }),
  ]);
  const decision = cardDecision({ jobId: '111', title: 'Backend Engineer' });
  assert.equal(decision.action, 'skip');
  assert.match(decision.reason, /answers unchanged/);
});

test('a title that is plainly the wrong role is skipped without opening', () => {
  seed([]);
  for (const [title, pattern] of [
    ['Senior .NET Developer', /\.net/],
    ['Junior Software Engineer', /junior/],
    ['Senior Data Engineer - AWS', /data engineer/],
  ]) {
    const decision = cardDecision({ jobId: '111', title });
    assert.equal(decision.action, 'skip', title);
    assert.match(decision.reason, pattern, title);
    assert.equal(decision.log, true);
  }
});

test('a job seen earlier in the same run is skipped silently', () => {
  seed([]);
  const { seenThisRun } = require('../linkedin');
  assert.equal(cardDecision({ jobId: '111', title: 'Senior Java Developer' }).action, 'open');
  seenThisRun.add('111');
  const decision = cardDecision({ jobId: '111', title: 'Senior Java Developer' });
  assert.equal(decision.action, 'skip');
  assert.equal(decision.log, false, 'a repeat sighting within one run must not be logged again');
  resetRunState();
});

test('the checks are ordered cheapest-first', () => {
  seed([row({ status: 'applied', title: 'Senior .NET Developer' })]);
  assert.equal(
    cardDecision({ jobId: '111', title: 'Senior .NET Developer' }).reason,
    'already applied'
  );
});

test('a missing title does not by itself cause a skip', () => {
  seed([]);
  assert.equal(cardDecision({ jobId: '111', title: '' }).action, 'open');
  assert.equal(cardDecision({ jobId: '111' }).action, 'open');
});

test('turning the title screen off changes the decision', () => {
  seed([]);
  const original = config.titleFilters;
  try {
    config.titleFilters = { enabled: false };
    assert.equal(cardDecision({ jobId: '111', title: 'Senior .NET Developer' }).action, 'open');
  } finally {
    config.titleFilters = original;
  }
});
