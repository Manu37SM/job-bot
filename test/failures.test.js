const test = require('node:test');
const assert = require('node:assert/strict');

const { isTransient, describeCode, FAILURE_CODES } = require('../logger');
const { throttleMessageIn, pacingConfig } = require('../linkedin');
const {
  normalizeQuestion,
  groupUnanswered,
  groupBlockers,
  suggestFix,
  buildReport,
} = require('../failure-report');

test('deterministic failures are not retried, transient ones are', () => {
  // The whole point of the split: re-running a form the bot has no answer for
  // produces the identical failure, so it must not be retried.
  assert.equal(isTransient('unanswerable'), false);
  assert.equal(isTransient('invalid_field'), false);
  assert.equal(isTransient('stuck_form'), true);
  assert.equal(isTransient('timeout'), true);
  assert.equal(isTransient('unconfirmed_submit'), true);
  // An unrecognised code is assumed transient — better to retry once than to
  // permanently park a job over a code someone forgot to register.
  assert.equal(isTransient('something_new'), true);
});

test('every registered failure code has a human-readable label', () => {
  for (const code of Object.keys(FAILURE_CODES)) {
    assert.notEqual(describeCode(code), code, `${code} has no label`);
  }
});

test('the LinkedIn rate-limit interstitial is recognised and quoted back', () => {
  const page = [
    'Jobs',
    "We noticed you're applying at a fast pace. To ensure genuine applications get the attention they deserve, we've briefly paused Easy Apply as a safeguard.",
    'You can continue shortly.',
  ].join('\n');
  const message = throttleMessageIn(page);
  assert.match(message, /applying at a fast pace/);
});

test('an ordinary job page is not mistaken for a rate limit', () => {
  const page =
    'Senior Backend Engineer\nEasy Apply\nAbout the job\nWe move at a fast pace as a team.';
  assert.equal(throttleMessageIn(page), '');
});

test('pacing falls back to safe defaults when config omits it', () => {
  const { min, max, breakEvery } = pacingConfig();
  assert.ok(min >= 45, 'floor must stay well above the old 1s pause');
  assert.ok(max > min);
  assert.ok(breakEvery > 0);
});

test('the same question asked by two companies collapses into one report row', () => {
  const failures = [
    {
      link: 'https://a',
      title: 'A',
      company: 'A Co',
      unanswered: [
        { kind: 'text', question: 'How many years of experience do you have with Kubernetes?' },
      ],
    },
    {
      link: 'https://b',
      title: 'B',
      company: 'B Co',
      unanswered: [
        { kind: 'text', question: 'how many years of experience do you have with Kubernetes' },
      ],
    },
  ];
  const groups = groupUnanswered(failures);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].jobs.length, 2);
});

test('unanswered questions are ranked by how many applications they cost', () => {
  const failures = [
    { unanswered: [{ kind: 'radio', question: 'Rare question?' }] },
    { unanswered: [{ kind: 'radio', question: 'Common question?' }] },
    { unanswered: [{ kind: 'radio', question: 'Common question?' }] },
  ];
  const groups = groupUnanswered(failures);
  assert.equal(groups[0].question, 'Common question?');
  assert.equal(groups[0].jobs.length, 2);
});

test('normalizeQuestion ignores trailing punctuation and whitespace noise', () => {
  assert.equal(normalizeQuestion('  Years   of Java?? '), normalizeQuestion('years of java'));
});

test('fix suggestions point at the file that actually holds the answer', () => {
  assert.match(
    suggestFix({ question: 'How many years of experience do you have with Kong Gateway?' }),
    /skillExperienceYears/
  );
  assert.match(suggestFix({ question: 'What is your expected CTC?' }), /expectedCTC/);
  assert.match(suggestFix({ question: "Do you hold a bachelor's degree?" }), /education/);
  assert.match(suggestFix({ question: 'What is your notice period?' }), /noticePeriod/);
});

test('rejected field values are grouped separately from unanswered questions', () => {
  const groups = groupBlockers([
    { blockers: ['Years of experience: Please enter a whole number'] },
    { blockers: ['Years of experience: Please enter a whole number'] },
  ]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].jobs.length, 2);
});

test('the report names the blocking question and the job it blocked', () => {
  const report = buildReport([
    {
      jobId: '1',
      title: 'Backend Engineer',
      company: 'Acme',
      link: 'https://www.linkedin.com/jobs/view/1',
      code: 'unanswerable',
      reason: 'No answer for: Years of Rust?',
      appliedAt: '2026-08-27T10:00:00.000Z',
      totalFailures: 1,
      unanswered: [{ kind: 'text', question: 'Years of Rust?' }],
    },
  ]);
  assert.match(report, /Years of Rust\?/);
  assert.match(report, /Backend Engineer/);
  assert.match(report, /linkedin\.com\/jobs\/view\/1/);
  assert.match(report, /waiting on an answer from you/);
});

test('a pipe in a question cannot break the markdown table', () => {
  const report = buildReport([
    {
      jobId: '2',
      title: 'T',
      company: 'C',
      code: 'unanswerable',
      appliedAt: '2026-08-27T10:00:00.000Z',
      unanswered: [{ kind: 'text', question: 'Java | Node | Go?' }],
    },
  ]);
  assert.match(report, /Java \\\| Node \\\| Go\?/);
});

test('the technology is pulled from the last "with/in/using", not the first "of"', () => {
  const { extractSkill } = require('../failure-report');
  assert.equal(
    extractSkill('How many years of experience do you have with Kubernetes?'),
    'Kubernetes'
  );
  assert.equal(extractSkill('Years of experience in Spring Boot'), 'Spring Boot');
  assert.equal(
    extractSkill('How many years of work experience do you have using Node.js?'),
    'Node.js'
  );
  assert.equal(extractSkill('What is your expected CTC?'), '');
});

test('the same question in two casings is counted once, not twice', () => {
  const { normalizeQuestion } = require('../logger');
  assert.equal(
    normalizeQuestion('How many years of experience do you have with Kubernetes?'),
    normalizeQuestion('how many years of experience do you have with kubernetes')
  );
});

test('report links point at the job permalink, not the search page it was found on', () => {
  const { jobUrl } = require('../failure-report');
  assert.equal(
    jobUrl({
      jobId: '4451627000',
      link: 'https://www.linkedin.com/jobs/search/?currentJobId=4451627000&start=200',
    }),
    'https://www.linkedin.com/jobs/view/4451627000'
  );
  assert.equal(jobUrl({ jobId: 'undefined', link: 'https://fallback' }), 'https://fallback');
});

test('entries from before diagnostics existed are labelled honestly', () => {
  assert.match(describeCode(undefined), /before diagnostics/i);
  assert.equal(describeCode('timeout'), 'Timed out');
});

test('a job description that says "try again later" does not abort the run', () => {
  // The page text scanned for throttling includes the job description, so ordinary
  // English in a posting must not read as LinkedIn's rate-limit notice.
  const jd = [
    'Senior Backend Engineer',
    'We review every application. If you do not hear from us, try again later.',
    'We move at a fast pace and value unusual activity in open source.',
  ].join('\n');
  assert.equal(throttleMessageIn(jd), '');
  assert.equal(throttleMessageIn(jd, ''), '');
});

test('the real interstitial is caught wherever it appears', () => {
  const notice =
    "We noticed you're applying at a fast pace. To ensure genuine applications get the attention they deserve, we've briefly paused Easy Apply as a safeguard against automated inauthentic activities.";
  assert.match(throttleMessageIn(notice), /applying at a fast pace/);
  assert.match(throttleMessageIn('', notice), /applying at a fast pace/);
  assert.match(throttleMessageIn('Jobs', 'You have reached the daily application limit'), /daily application limit/);
});

test('ambiguous wording counts only inside an alert or dialog', () => {
  // "Try again later" in a posting is noise; in a LinkedIn alert it is a throttle.
  assert.equal(throttleMessageIn('Please try again later if the page fails to load.'), '');
  assert.match(throttleMessageIn('', 'Something went wrong. Please try again later.'), /try again later/i);
  assert.match(throttleMessageIn('', 'We detected unusual activity on your account'), /unusual activity/i);
});

test('every fix suggestion points at the file that actually holds the answer', () => {
  const expectations = [
    ['What is your date of birth?', /Protected-characteristic/],
    ['What is your marital status?', /Protected-characteristic/],
    ['What is your gender?', /Protected-characteristic/],
    ['Are you willing to relocate?', /locations.*willingToRelocate/],
    ['Are you willing to work night shifts?', /dayShiftOnly/],
    ['Do you have experience with Kubernetes?', /skills.*resume-profile/],
    ['How many years of experience do you have with Python?', /'Python'.*skillExperienceYears/],
    ['Are you authorized to work in the US?', /authorizedCountries/],
    ['What is your expected CTC?', /expectedCTC/],
    ['Do you hold a PMP certification?', /certifications/],
    ["Do you have a Master's degree?", /education/],
    ['What is your notice period?', /noticePeriod/],
  ];
  for (const [question, pattern] of expectations) {
    assert.match(suggestFix({ question }), pattern, question);
  }
});

test('a vague capability question is not sent to the skills list', () => {
  // "Experience in fast-paced environments" is not something to add to `skills`,
  // and saying so sends the reader on a pointless errand.
  assert.match(
    suggestFix({ question: 'Do you have experience working in fast-paced environments?' }),
    /Not a technology/
  );
});
