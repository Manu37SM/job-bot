const os = require('os');
const path = require('path');
const fs = require('fs');

const SCRATCH = path.join(os.tmpdir(), `job-bot-stats-${process.pid}.json`);
process.env.JOB_BOT_LOG = SCRATCH;

const test = require('node:test');
const assert = require('node:assert/strict');

const realLog = console.log;
const captured = [];
const capture = () => {
  console.log = (...args) => captured.push(args.join(' '));
};
const release = () => {
  console.log = realLog;
};

test.after(() => {
  release();
  for (const f of [SCRATCH, `${SCRATCH}.tmp`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

function run(rows) {
  fs.writeFileSync(SCRATCH, JSON.stringify(rows));
  captured.length = 0;
  delete require.cache[require.resolve('../logger')];
  delete require.cache[require.resolve('../stats')];
  capture();
  try {
    require('../stats').main();
  } finally {
    release();
  }
  return captured.join('\n');
}

const applied = (over = {}) => ({
  jobId: String(Math.random()),
  title: 'Backend Engineer',
  company: 'Acme',
  platform: 'LinkedIn',
  status: 'applied',
  appliedAt: '2026-08-20T10:00:00.000Z',
  ...over,
});

test('an empty log says so rather than dividing by zero', () => {
  const out = run([]);
  assert.match(out, /No applications logged yet/);
});

test('concentration surfaces an employer taking a large share', () => {
  const rows = [
    ...Array.from({ length: 9 }, () => applied({ company: 'Jobgether' })),
    applied({ company: 'Globex' }),
  ];
  const out = run(rows);
  assert.match(out, /Jobgether/);
  assert.match(out, /9/);
  assert.match(out, /% of everything sent/);
});

test('company spellings are counted as one employer', () => {
  const out = run([
    applied({ company: 'Acme Pvt Ltd' }),
    applied({ company: 'Acme Private Limited' }),
    applied({ company: 'Acme' }),
  ]);
  assert.match(out, /Concentration — 1 companies/);
});

test('days over the daily cap are called out', () => {
  const rows = Array.from({ length: 30 }, (_, i) =>
    applied({ appliedAt: `2026-07-16T${String(i % 24).padStart(2, '0')}:00:00.000Z` })
  );
  const out = run(rows);
  assert.match(out, /2026-07-16/);
  assert.match(out, /over today's cap/);
  assert.match(out, /Volume, not speed/);
});

test('role fit is reported retrospectively', () => {
  const out = run([
    applied({ title: 'Senior Java Developer' }),
    applied({ title: 'Junior Java Developer' }),
    applied({ title: 'Senior .NET Developer' }),
  ]);
  assert.match(out, /would now be screened out/);
  assert.match(out, /junior role/);
  assert.match(out, /\.net/i);
});

test('keywords missing from your search config are flagged', () => {
  const out = run([
    applied({ title: 'Kubernetes Platform Engineer' }),
    applied({ title: 'Kubernetes Platform Engineer' }),
  ]);
  assert.match(out, /kubernetes/);
  assert.match(out, /not in config\.positions/);
});

test('malformed rows do not crash the report', () => {
  assert.doesNotThrow(() =>
    run([
      applied(),
      { status: 'applied' },
      { status: 'applied', title: null, company: null, appliedAt: 'nonsense' },
    ])
  );
});

test('repeated failures on one job are surfaced', () => {
  const rows = [
    applied(),
    ...Array.from({ length: 9 }, () => ({
      jobId: 'stuck',
      title: 'Java Technical Architect',
      company: 'Atain',
      platform: 'LinkedIn',
      status: 'failed',
      code: 'timeout',
      appliedAt: '2026-08-20T10:00:00.000Z',
    })),
  ];
  const out = run(rows);
  assert.match(out, /Repeated failures/);
  assert.match(out, /1 distinct jobs produced 9 failure records/);
  assert.match(out, /beyond the 3-try cap/);
  assert.match(out, /Java Technical Architect/);
});

test('seniority bands that never convert are flagged', () => {
  const out = run([
    applied({ title: 'Senior Java Developer' }),
    {
      jobId: 'a',
      title: 'Java Technical Architect',
      company: 'X',
      platform: 'LinkedIn',
      status: 'failed',
      appliedAt: '2026-08-20T10:00:00.000Z',
    },
  ]);
  assert.match(out, /Seniority bands/);
  assert.match(out, /architect.*never converts/s);
});

test('a step change in the success rate is flagged', () => {
  const day = (date, applied, failing) => [
    ...Array.from({ length: applied }, (_, i) => ({
      jobId: `${date}-a${i}`,
      title: 'Backend Engineer',
      company: 'Acme',
      platform: 'LinkedIn',
      status: 'applied',
      appliedAt: `${date}T10:00:00.000Z`,
    })),
    ...Array.from({ length: failing }, (_, i) => ({
      jobId: `${date}-f${i}`,
      title: 'Backend Engineer',
      company: 'Acme',
      platform: 'LinkedIn',
      status: 'failed',
      appliedAt: `${date}T10:00:00.000Z`,
    })),
  ];

  const healthy = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'].flatMap(
    (d) => day(d, 18, 2)
  );
  const broken = ['2026-08-10', '2026-08-11', '2026-08-12'].flatMap((d) => day(d, 8, 12));

  const out = run([...healthy, ...broken]);
  assert.match(out, /Success rate per run/);
  assert.match(out, /point drop/);
});

test('a steady success rate is not flagged as a regression', () => {
  const day = (date) =>
    Array.from({ length: 20 }, (_, i) => ({
      jobId: `${date}-${i}`,
      title: 'Backend Engineer',
      company: 'Acme',
      platform: 'LinkedIn',
      status: i < 16 ? 'applied' : 'failed',
      appliedAt: `${date}T10:00:00.000Z`,
    }));
  const out = run(
    [
      '2026-08-01',
      '2026-08-02',
      '2026-08-03',
      '2026-08-04',
      '2026-08-05',
      '2026-08-06',
      '2026-08-07',
      '2026-08-08',
    ].flatMap(day)
  );
  assert.match(out, /Success rate per run/);
  assert.doesNotMatch(out, /point drop/);
});

test('the flag says the cause is unreadable when no failure has a code', () => {
  const day = (date, applied, failing) => [
    ...Array.from({ length: applied }, (_, i) => ({
      jobId: `${date}a${i}`,
      title: 'T',
      company: 'C',
      platform: 'LinkedIn',
      status: 'applied',
      appliedAt: `${date}T10:00:00.000Z`,
    })),
    ...Array.from({ length: failing }, (_, i) => ({
      jobId: `${date}f${i}`,
      title: 'T',
      company: 'C',
      platform: 'LinkedIn',
      status: 'failed',
      appliedAt: `${date}T10:00:00.000Z`,
    })),
  ];
  const out = run([
    ...['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'].flatMap((d) =>
      day(d, 18, 2)
    ),
    ...['2026-08-10', '2026-08-11', '2026-08-12'].flatMap((d) => day(d, 8, 12)),
  ]);
  assert.match(out, /cannot be read/);
});

test('broad failure across many employers is distinguished from a few stuck jobs', () => {
  const day = (date, applied, failures) => [
    ...Array.from({ length: applied }, (_, i) => ({
      jobId: `${date}a${i}`,
      title: 'Backend Engineer',
      company: 'Acme',
      platform: 'LinkedIn',
      status: 'applied',
      appliedAt: `${date}T10:00:00.000Z`,
    })),
    ...failures.map((company, i) => ({
      jobId: `${date}f${i}`,
      title: 'Backend Engineer',
      company,
      platform: 'LinkedIn',
      status: 'failed',
      appliedAt: `${date}T10:00:00.000Z`,
    })),
  ];

  const healthy = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'].flatMap(
    (d) => day(d, 18, ['Stuck Co', 'Stuck Co'])
  );
  const broken = ['2026-08-10', '2026-08-11', '2026-08-12'].flatMap((d) =>
    day(
      d,
      8,
      Array.from({ length: 12 }, (_, i) => `Company ${i}`)
    )
  );

  const out = run([...healthy, ...broken]);
  assert.match(out, /point drop/);
  assert.match(out, /spread across ~\d+ employers/);
  assert.match(out, /something systemic/);
});

test('a concentrated collapse is named as a retry loop, not a markup change', () => {
  const day = (date, applied, failures) => [
    ...Array.from({ length: applied }, (_, i) => ({
      jobId: `${date}a${i}`,
      title: 'T',
      company: `Co ${i}`,
      platform: 'LinkedIn',
      status: 'applied',
      appliedAt: `${date}T10:00:00.000Z`,
    })),
    ...failures.map((company, i) => ({
      jobId: `${date}f${i}`,
      title: 'T',
      company,
      platform: 'LinkedIn',
      status: 'failed',
      appliedAt: `${date}T10:00:00.000Z`,
    })),
  ];
  const healthy = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'].flatMap(
    (d) =>
      day(
        d,
        18,
        Array.from({ length: 4 }, (_, i) => `Spread ${i}`)
      )
  );
  const broken = ['2026-08-10', '2026-08-11', '2026-08-12'].flatMap((d) =>
    day(
      d,
      6,
      Array.from({ length: 14 }, () => 'One Stuck Co')
    )
  );

  const out = run([...healthy, ...broken]);
  assert.match(out, /stuck in a retry loop/);
  assert.doesNotMatch(out, /something systemic/);
});

test('failure codes are grouped into causes with different owners', () => {
  const fail = (code, i) => ({
    jobId: `f${code}${i}`,
    title: 'T',
    company: `Co${i}`,
    platform: 'LinkedIn',
    status: 'failed',
    code,
    appliedAt: '2026-08-28T10:00:00.000Z',
  });

  const markup = run([
    applied(),
    ...Array.from({ length: 14 }, (_, i) => fail('modal_missing', i)),
    ...Array.from({ length: 3 }, (_, i) => fail('unanswerable', i)),
  ]);
  assert.match(markup, /What the failures say/);
  assert.match(markup, /LinkedIn markup changed/);
  assert.match(markup, /Mostly: LinkedIn markup changed/, 'the headline must not be lowercased');
  assert.match(markup, /Selectors need updating/);

  const answers = run([
    applied(),
    ...Array.from({ length: 12 }, (_, i) => fail('unanswerable', i)),
    ...Array.from({ length: 2 }, (_, i) => fail('timeout', i)),
  ]);
  assert.match(answers, /Mostly: Your answers are incomplete/);
  assert.match(answers, /needs-review\.md names each question/);

  const throttled = run([
    applied(),
    ...Array.from({ length: 10 }, (_, i) => fail('unconfirmed_submit', i)),
  ]);
  assert.match(throttled, /Mostly: LinkedIn rejecting submissions/);
  assert.match(throttled, /throttled/);
});

test('uncoded failures are excluded and the exclusion is stated', () => {
  const out = run([
    applied(),
    {
      jobId: 'old',
      title: 'T',
      company: 'C',
      platform: 'LinkedIn',
      status: 'failed',
      appliedAt: '2026-08-01T10:00:00.000Z',
    },
    {
      jobId: 'new',
      title: 'T',
      company: 'C',
      platform: 'LinkedIn',
      status: 'failed',
      code: 'timeout',
      appliedAt: '2026-08-28T10:00:00.000Z',
    },
  ]);
  assert.match(out, /1 older failures carry no code/);
});

test('a log with no coded failures omits the section entirely', () => {
  const out = run([
    applied(),
    {
      jobId: 'x',
      title: 'T',
      company: 'C',
      platform: 'LinkedIn',
      status: 'failed',
      appliedAt: '2026-08-01T10:00:00.000Z',
    },
  ]);
  assert.doesNotMatch(out, /What the failures say/);
});
