const test = require('node:test');
const assert = require('node:assert/strict');

const { answerQuestion } = require('../resume-answers');
const policy = require('../question-policy');
const {
  deterministicAnswer,
  localFallback,
  matchNumericOption,
  normalizeAnswer,
} = require('../answer-utils');
const { buildNumericCandidates } = require('../field-value');
const { assessFit, requiredExperienceYears } = require('../job-fit');
const { suggestFix, buildReport, buildDryRunReport } = require('../failure-report');
const profile = require('../resume-profile');

const realConsole = { log: console.log, warn: console.warn, error: console.error };
test.before(() => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
});
test.after(() => Object.assign(console, realConsole));

const HOSTILE = [
  '',
  ' ',
  '\n\n\n',
  '\t',
  null,
  undefined,
  'a'.repeat(2000),
  '?'.repeat(500),
  '(((((((((((',
  '[a-z]+*?{2,}\\',
  "$&$`$'$1",
  String.fromCharCode(0, 1, 27, 127),
  String.fromCharCode(0xd800),
  '../../etc/passwd',
  '<script>alert(1)</script>',
  '-0',
  'NaN',
  'Infinity',
  '1e400',
  'Do you have a Master' + String.fromCharCode(8217) + 's degree?',
];

const OPTION_SETS = [
  [],
  ['Yes'],
  ['', '  '],
  ['(', ')', '['],
  ['$&', '$1'],
  Array.from({ length: 100 }, (_, i) => `Option ${i}`),
];

const TYPES = ['text', 'number', 'textarea', 'radio', 'checkbox', 'select', ''];

const SYNC_FUNCTIONS = [
  ['classify', (q) => policy.classify(q)],
  ['mayGuess', (q) => policy.mayGuess(q)],
  ['extractSubject', (q) => policy.extractSubject(q)],
  ['isTenureQuestion', (q) => policy.isTenureQuestion(q)],
  ['looksLikeTechnology', (q) => policy.looksLikeTechnology(q)],
  ['requiredExperienceYears', (q) => requiredExperienceYears(q)],
  ['assessFit', (q) => assessFit(q)],
  ['tenureYears', (q) => profile.tenureYears({ period: String(q) })],
];

const OPTION_FUNCTIONS = [
  ['eeoAnswer', (q, o) => policy.eeoAnswer(o)],
  ['relocationAnswer', (q, o) => policy.relocationAnswer(q, o)],
  ['workAuthorizationAnswer', (q, o) => policy.workAuthorizationAnswer(q, o)],
  ['sponsorshipAnswer', (q, o) => policy.sponsorshipAnswer(q, o)],
  ['customAnswer', (q, o) => policy.customAnswer(q, o)],
  ['matchNumericOption', (q, o) => matchNumericOption(q, o)],
  ['suggestFix', (q, o) => suggestFix({ question: q, options: o })],
];

test('no single-argument helper throws on hostile input', () => {
  const crashes = [];
  for (const input of HOSTILE) {
    for (const [name, fn] of SYNC_FUNCTIONS) {
      try {
        fn(input);
      } catch (e) {
        crashes.push(`${name}(${JSON.stringify(String(input).slice(0, 20))}): ${e.message}`);
      }
    }
  }
  assert.deepEqual(crashes, [], crashes.join('\n'));
});

test('no option-taking helper throws on hostile input', () => {
  const crashes = [];
  for (const input of HOSTILE) {
    for (const options of OPTION_SETS) {
      for (const [name, fn] of OPTION_FUNCTIONS) {
        try {
          fn(input, options);
        } catch (e) {
          crashes.push(`${name}: ${e.message}`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(crashes)], [], crashes.join('\n'));
});

test('the full answering path never throws, whatever it is handed', async () => {
  const crashes = [];
  for (const input of HOSTILE) {
    for (const options of OPTION_SETS.slice(0, 4)) {
      for (const type of TYPES) {
        try {
          await answerQuestion(input, 'Role', 'Co', type, options);
          deterministicAnswer(input, type, options);
          localFallback(input, type, options);
          normalizeAnswer(input, type, options);
          buildNumericCandidates(input, String(input), { inputType: type, step: '' });
          profile.answerFromResume(input, type, options);
        } catch (e) {
          crashes.push(`[${type}] ${e.message}`);
        }
      }
    }
  }
  assert.deepEqual([...new Set(crashes)], [], crashes.join('\n'));
});

test('the report builders survive malformed log entries', () => {
  assert.doesNotThrow(() =>
    buildReport([{}, { code: null }, { title: null, company: undefined, unanswered: [{}] }])
  );
  assert.doesNotThrow(() => buildDryRunReport({ jobs: [{}], screened: [{}] }));
  assert.doesNotThrow(() => buildDryRunReport({}));
});

test('no regex backtracks its way into freezing the run', () => {
  const pathological = {
    letters: 'a'.repeat(20000),
    spaces: ' '.repeat(20000) + '?',
    digits: '1'.repeat(5000),
    'repeated clause': 'Do you have experience with '.repeat(200) + 'Java?',
    'repeated years': 'years of experience '.repeat(200),
    'how long': 'how long '.repeat(300) + 'been at your current company',
  };

  const slow = [];
  for (const [label, input] of Object.entries(pathological)) {
    for (const [name, fn] of [
      ...SYNC_FUNCTIONS,
      [
        'buildNumericCandidates',
        (q) => buildNumericCandidates('4.1', q, { inputType: 'number', step: '' }),
      ],
    ]) {
      const started = process.hrtime.bigint();
      try {
        fn(input);
      } catch {
        continue;
      }
      const ms = Number(process.hrtime.bigint() - started) / 1e6;
      if (ms > 250) slow.push(`${name} took ${ms.toFixed(0)}ms on ${label}`);
    }
  }
  assert.deepEqual(slow, [], slow.join('\n'));
});

test('bounding the period input did not break real date parsing', () => {
  assert.equal(profile.tenureYears({ period: 'September 2024 – June 2026' }), 1.7);
  assert.ok(profile.tenureYears({ period: 'July 2022 – Present' }) > 3);
  assert.equal(profile.tenureYears({ period: 'a'.repeat(20000) }), null);
});
