const test = require('node:test');
const assert = require('node:assert/strict');

const { companyKey, companyCapReached, noteCompanyApplication, resetRunState } = require('../linkedin');
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
