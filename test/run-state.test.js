const test = require('node:test');
const assert = require('node:assert/strict');

const {
  companyKey,
  companyCapReached,
  noteCompanyApplication,
  resetRunState,
} = require('../linkedin');
const config = require('../config');

test('company names normalise across legal-suffix noise', () => {
  // LinkedIn renders the same employer half a dozen ways; a per-company cap that
  // treats them as different companies is no cap at all.
  const same = [
    ['Acme Technologies Pvt Ltd', 'Acme Technologies Private Limited'],
    ['Globex Inc', 'Globex'],
    ['Infosys', 'Infosys Limited'],
    ['Delaplex Solutions', 'delaplex'],
    ['Foo Bar LLP', 'Foo-Bar'],
  ];
  for (const [a, b] of same) assert.equal(companyKey(a), companyKey(b), `${a} vs ${b}`);
});

test('genuinely different companies stay distinct', () => {
  assert.notEqual(companyKey('Acme'), companyKey('Beta'));
  assert.notEqual(companyKey('Tata Consultancy'), companyKey('Tech Mahindra'));
});

test('a blank company name never triggers the cap', () => {
  resetRunState();
  assert.equal(companyKey(''), '');
  assert.equal(companyCapReached(''), false);
  assert.equal(companyCapReached(undefined), false);
});

test('the cap trips only after the configured number of applications', () => {
  const original = config.maxApplicationsPerCompanyPerRun;
  try {
    config.maxApplicationsPerCompanyPerRun = 2;
    resetRunState();
    assert.equal(companyCapReached('Acme Pvt Ltd'), false);
    noteCompanyApplication('Acme Pvt Ltd');
    assert.equal(companyCapReached('Acme Pvt Ltd'), false);
    noteCompanyApplication('Acme Private Limited'); // same company, different spelling
    assert.equal(companyCapReached('Acme'), true, 'the two spellings must share a counter');
    assert.equal(companyCapReached('Globex'), false, 'unrelated companies are unaffected');
  } finally {
    config.maxApplicationsPerCompanyPerRun = original;
  }
});

test('setting the cap to 0 disables it', () => {
  const original = config.maxApplicationsPerCompanyPerRun;
  try {
    config.maxApplicationsPerCompanyPerRun = 0;
    resetRunState();
    for (let i = 0; i < 10; i++) noteCompanyApplication('Acme');
    assert.equal(companyCapReached('Acme'), false);
  } finally {
    config.maxApplicationsPerCompanyPerRun = original;
  }
});

test('resetRunState clears the counters between runs', () => {
  const original = config.maxApplicationsPerCompanyPerRun;
  try {
    config.maxApplicationsPerCompanyPerRun = 1;
    resetRunState();
    noteCompanyApplication('Acme');
    assert.equal(companyCapReached('Acme'), true);
    resetRunState();
    assert.equal(companyCapReached('Acme'), false);
  } finally {
    config.maxApplicationsPerCompanyPerRun = original;
  }
});

const { failureTally, failureBudgetExhausted } = require('../linkedin');

test('a run stops after too many failures rather than grinding on', () => {
  const original = { run: config.maxFailuresPerRun, streak: config.maxConsecutiveFailures };
  try {
    config.maxFailuresPerRun = 3;
    config.maxConsecutiveFailures = 99;
    resetRunState();
    assert.equal(failureBudgetExhausted(), null);
    failureTally.total = 2;
    assert.equal(failureBudgetExhausted(), null);
    failureTally.total = 3;
    assert.match(failureBudgetExhausted(), /3 failures this run/);
  } finally {
    config.maxFailuresPerRun = original.run;
    config.maxConsecutiveFailures = original.streak;
    resetRunState();
  }
});

test('a streak of failures stops the run even under the total budget', () => {
  const original = { run: config.maxFailuresPerRun, streak: config.maxConsecutiveFailures };
  try {
    config.maxFailuresPerRun = 100;
    config.maxConsecutiveFailures = 3;
    resetRunState();
    failureTally.total = 3;
    failureTally.consecutive = 3;
    // A streak usually means something systemic — a markup change, a half-dead
    // session — not bad luck on three separate postings.
    assert.match(failureBudgetExhausted(), /in a row/);
  } finally {
    config.maxFailuresPerRun = original.run;
    config.maxConsecutiveFailures = original.streak;
    resetRunState();
  }
});

test('both budgets can be disabled', () => {
  const original = { run: config.maxFailuresPerRun, streak: config.maxConsecutiveFailures };
  try {
    config.maxFailuresPerRun = 0;
    config.maxConsecutiveFailures = 0;
    resetRunState();
    failureTally.total = 500;
    failureTally.consecutive = 500;
    assert.equal(failureBudgetExhausted(), null);
  } finally {
    config.maxFailuresPerRun = original.run;
    config.maxConsecutiveFailures = original.streak;
    resetRunState();
  }
});

test('resetRunState clears the failure tallies', () => {
  failureTally.total = 7;
  failureTally.consecutive = 7;
  resetRunState();
  assert.equal(failureTally.total, 0);
  assert.equal(failureTally.consecutive, 0);
});

const { cleanText, cleanCompany, JOB_CARD_SELECTORS } = require('../linkedin');

test('a wrapped job title keeps all of its words', () => {
  // Splitting on the newline turned "Backend\nEngineer" into "Backend" — a title
  // wraps across lines, so its newlines are layout, not structure.
  assert.equal(cleanText('  Backend\nEngineer  '), 'Backend Engineer');
  assert.equal(cleanText('STAFF SOFTWARE ENGINEER - FDE  '), 'STAFF SOFTWARE ENGINEER - FDE');
  assert.equal(cleanText(null), '');
});

test('a company name drops the metadata that follows it', () => {
  // The opposite case: line two is "1,001-5,000 employees", and anything after a
  // "·" is the location.
  assert.equal(cleanCompany('Acme Corp · Mumbai, Maharashtra, India'), 'Acme Corp');
  assert.equal(cleanCompany('Globex\n1,001-5,000 employees'), 'Globex');
  assert.equal(cleanCompany('  Initech  '), 'Initech');
  // A "|" is part of plenty of real company names and must survive.
  assert.equal(cleanCompany('MRSOOL | مرسول'), 'MRSOOL | مرسول');
});

test('there is more than one way to find a job card', () => {
  // One hard-coded class was a single point of silent failure: when it stopped
  // matching, every search returned zero cards and the run reported "no jobs".
  assert.ok(JOB_CARD_SELECTORS.length > 1);
  assert.ok(JOB_CARD_SELECTORS.includes('.job-card-container'));
});

const { retryBudgetSpent } = require('../linkedin');

test('a backlog of old failures cannot consume the whole run', () => {
  // 110 old failures appear in the same search results as fresh postings and are
  // reached first, so without a cap a run spends its entire budget re-attempting
  // known-bad jobs and applies to nothing new.
  const original = config.maxRetriedFailuresPerRun;
  try {
    config.maxRetriedFailuresPerRun = 3;
    resetRunState();
    assert.equal(retryBudgetSpent(), false);
    failureTally.retries = 2;
    assert.equal(retryBudgetSpent(), false);
    failureTally.retries = 3;
    assert.equal(retryBudgetSpent(), true);
  } finally {
    config.maxRetriedFailuresPerRun = original;
    resetRunState();
  }
});

test('the retry cap can be disabled', () => {
  const original = config.maxRetriedFailuresPerRun;
  try {
    config.maxRetriedFailuresPerRun = 0;
    resetRunState();
    failureTally.retries = 500;
    assert.equal(retryBudgetSpent(), false);
  } finally {
    config.maxRetriedFailuresPerRun = original;
    resetRunState();
  }
});

test('resetRunState clears the retry tally too', () => {
  failureTally.retries = 9;
  resetRunState();
  assert.equal(failureTally.retries, 0);
});

const os = require('os');
const fsx = require('fs');
const pathx = require('path');

test('a lifetime cap stops slow accumulation at one employer', () => {
  // The per-run cap stops a burst. In the real log, 27 applications had gone to a
  // single job-aggregator account and 13 to one recruitment consultancy — 18% of
  // every application ever sent, to four companies, none of it in one run.
  const scratch = pathx.join(os.tmpdir(), `job-bot-lifetime-${process.pid}.json`);
  const previous = process.env.JOB_BOT_LOG;
  process.env.JOB_BOT_LOG = scratch;
  delete require.cache[require.resolve('../logger')];
  const logger = require('../logger');
  const original = config.maxApplicationsPerCompanyTotal;

  try {
    config.maxApplicationsPerCompanyTotal = 3;
    const rows = Array.from({ length: 3 }, (_, i) => ({
      jobId: String(i),
      company: i === 0 ? 'Acme Pvt Ltd' : 'Acme Private Limited', // same employer
      platform: 'LinkedIn',
      status: 'applied',
      appliedAt: new Date().toISOString(),
    }));
    fsx.writeFileSync(scratch, JSON.stringify(rows));

    assert.equal(logger.companyApplicationCount('Acme', 'LinkedIn'), 3, 'spellings share a counter');
    assert.match(logger.companyLifetimeCapReached('Acme', 'LinkedIn'), /3× in total/);
    assert.equal(logger.companyLifetimeCapReached('Globex', 'LinkedIn'), null);

    config.maxApplicationsPerCompanyTotal = 0;
    assert.equal(logger.companyLifetimeCapReached('Acme', 'LinkedIn'), null, '0 disables the cap');
  } finally {
    config.maxApplicationsPerCompanyTotal = original;
    if (previous === undefined) delete process.env.JOB_BOT_LOG;
    else process.env.JOB_BOT_LOG = previous;
    delete require.cache[require.resolve('../logger')];
    if (fsx.existsSync(scratch)) fsx.unlinkSync(scratch);
  }
});
