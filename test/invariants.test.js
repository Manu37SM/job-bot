// Property tests. The individual cases elsewhere pin down specific bugs; these
// assert the rules that must hold across the whole space of phrasings, because the
// next false claim will arrive in wording nobody wrote a case for.
const test = require('node:test');
const assert = require('node:assert/strict');

const { answerQuestion } = require('../resume-answers');
const policy = require('../question-policy');
const profile = require('../resume-profile');
const config = require('../config');

const YN = ['Yes', 'No'];
const affirmative = (a) => /^(yes|yes,|i (?:do|am|have)|true|agree)/i.test(String(a).trim());
const negative = (a) => /^(no|no,|i (?:do not|don't|am not))/i.test(String(a).trim());

const ask = (q, options = YN, type = 'radio') => answerQuestion(q, 'Backend Engineer', 'Acme', type, options);

const cross = (templates, subjects) =>
  templates.flatMap((t) => subjects.map((s) => t.replace('{}', s)));

// Technologies that appear nowhere in the CV or the resume text.
const ABSENT = ['Rust', 'COBOL', 'Fortran', 'Elixir', 'Haskell', 'Scala', 'Erlang', 'Julia', 'Clojure', 'Delphi'];
const PRESENT = ['Java', 'Kafka', 'Kubernetes', 'Docker', 'React', 'PostgreSQL'];

const CAPABILITY_TEMPLATES = [
  'Do you have experience with {}?',
  'Are you proficient in {}?',
  'Do you have hands-on experience with {}?',
  'Are you familiar with {}?',
  'Do you have knowledge of {}?',
  'Have you worked with {}?',
  'Do you have professional experience with {}?',
];

test('no technology absent from the CV is ever claimed', async () => {
  const questions = cross(CAPABILITY_TEMPLATES, ABSENT);
  const claimed = [];
  for (const q of questions) {
    const answer = await ask(q);
    if (affirmative(answer)) claimed.push(`${q} -> ${answer}`);
  }
  assert.deepEqual(claimed, [], `claimed skills not on the CV:\n${claimed.join('\n')}`);
  assert.ok(questions.length >= 60, 'the corpus should be broad enough to mean something');
});

test('technologies that ARE on the CV are not needlessly denied', async () => {
  const denied = [];
  for (const q of cross(CAPABILITY_TEMPLATES, PRESENT)) {
    const answer = await ask(q);
    if (negative(answer)) denied.push(`${q} -> ${answer}`);
  }
  assert.deepEqual(denied, [], `denied skills that are on the CV:\n${denied.join('\n')}`);
});

test('no protected-characteristic question is ever answered with a substantive value', async () => {
  const questions = cross(
    [
      'What is your {}?',
      'Please select your {}',
      'How would you describe your {}?',
      'Do you identify with any {}?',
    ],
    ['gender', 'race', 'ethnicity', 'sexual orientation', 'religion', 'disability status', 'veteran status']
  ).concat([
    'Are you a protected veteran?',
    'Do you have a disability?',
    'Are you transgender?',
    'What is your marital status?',
    'What is your date of birth?',
    'Are you currently pregnant?',
  ]);

  const bad = [];
  for (const q of questions) {
    const options = ['Male', 'Female', 'Yes', 'No', 'I prefer not to say'];
    const answer = String(await ask(q, options));
    // The only permitted outcomes are silence or the form's own decline option.
    if (answer && !policy.DECLINE.test(answer)) bad.push(`${q} -> ${answer}`);
  }
  assert.deepEqual(bad, [], `answered a protected-characteristic question:\n${bad.join('\n')}`);
});

test('authorization is never claimed for a country not on the list', async () => {
  const countries = ['the United States', 'the US', 'the USA', 'the UK', 'Canada', 'Australia', 'Germany', 'Singapore', 'Japan'];
  const templates = [
    'Are you legally authorized to work in {}?',
    'Do you have the right to work in {}?',
    'Are you eligible to work in {}?',
    'Do you hold a valid work permit for {}?',
  ];
  const claimed = [];
  for (const q of cross(templates, countries)) {
    const answer = await ask(q);
    if (affirmative(answer)) claimed.push(`${q} -> ${answer}`);
  }
  assert.deepEqual(claimed, [], `claimed authorization abroad:\n${claimed.join('\n')}`);
});

test('authorization IS claimed for the country on the list', async () => {
  for (const q of [
    'Are you legally authorized to work in India?',
    'Do you have the right to work in India?',
    'Are you eligible to work in India?',
  ]) {
    assert.ok(affirmative(await ask(q)), q);
  }
});

test('sponsorship is never denied for a country requiring it', async () => {
  const templates = [
    'Will you require sponsorship to work in {}?',
    'Do you now or in the future require visa sponsorship for {}?',
    'Will you need employment visa sponsorship in {}?',
  ];
  const denied = [];
  for (const q of cross(templates, ['the United States', 'the UK', 'Canada', 'Germany'])) {
    const answer = await ask(q);
    if (negative(answer)) denied.push(`${q} -> ${answer}`);
  }
  assert.deepEqual(denied, [], `denied needing sponsorship abroad:\n${denied.join('\n')}`);
});

test('a quantity question never receives a yes/no', async () => {
  const templates = [
    'How many years of experience do you have with {}?',
    'How many months of experience do you have with {}?',
    'Years of experience in {}',
    'Number of years working with {}',
  ];
  const bad = [];
  for (const q of cross(templates, [...PRESENT, ...ABSENT])) {
    const answer = String(await ask(q, [], 'number'));
    if (/^(yes|no)$/i.test(answer.trim())) bad.push(`${q} -> ${answer}`);
  }
  assert.deepEqual(bad, [], `yes/no in a numeric field:\n${bad.join('\n')}`);
});

test('a claimed year count never exceeds total experience', async () => {
  const bad = [];
  for (const skill of [...PRESENT, ...ABSENT]) {
    const answer = await ask(`How many years of experience do you have with ${skill}?`, [], 'number');
    const years = Number(answer);
    if (Number.isFinite(years) && years > Number(config.experienceYears)) {
      bad.push(`${skill} -> ${answer} (total is ${config.experienceYears})`);
    }
  }
  assert.deepEqual(bad, [], `claimed more years in one skill than in total:\n${bad.join('\n')}`);
});

test('no credential absent from the CV is ever claimed', async () => {
  const credentials = ['PMP', 'CISSP', 'AWS Solutions Architect', 'Azure Administrator', 'CFA', 'Six Sigma Black Belt', 'PRINCE2', 'CCNA'];
  const templates = [
    'Do you hold a {} certification?',
    'Are you {} certified?',
    'Do you have a valid {} credential?',
  ];
  const claimed = [];
  for (const q of cross(templates, credentials)) {
    const answer = await ask(q);
    if (affirmative(answer)) claimed.push(`${q} -> ${answer}`);
  }
  assert.deepEqual(claimed, [], `claimed credentials not on the CV:\n${claimed.join('\n')}`);
});

test('no degree above the one held is ever claimed', async () => {
  const claimed = [];
  for (const q of cross(
    ['Do you have a {}?', 'Have you completed a {}?', 'Do you hold a {}?'],
    ["Master's degree", 'PhD', 'doctorate', 'MBA', 'postgraduate degree']
  )) {
    const answer = await ask(q);
    if (affirmative(answer)) claimed.push(`${q} -> ${answer}`);
  }
  assert.deepEqual(claimed, [], `claimed a degree above the one held:\n${claimed.join('\n')}`);
});

test('consent boilerplate still gets answered, or forms would never submit', async () => {
  const unanswered = [];
  for (const q of [
    'Do you consent to a background check?',
    'Do you agree to the terms and conditions?',
    'I acknowledge the privacy policy',
    'Do you consent to us processing your data?',
    'I certify that the information provided is accurate',
    'Do you agree to a reference check?',
  ]) {
    const answer = await ask(q);
    if (!answer) unanswered.push(q);
  }
  assert.deepEqual(unanswered, [], `consent boilerplate left blank:\n${unanswered.join('\n')}`);
});
