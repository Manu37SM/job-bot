const test = require('node:test');
const assert = require('node:assert/strict');

const policy = require('../question-policy');
const { deterministicAnswer } = require('../answer-utils');
const { answerQuestion } = require('../resume-answers');
const config = require('../config');

const YN = ['Yes', 'No'];
const ask = (q, options = YN, type = 'radio') =>
  answerQuestion(q, 'Backend Engineer', 'Acme', type, options);

test('protected-characteristic questions are classified, never guessed', () => {
  const questions = [
    'What is your gender?',
    'Are you a protected veteran?',
    'Do you have a disability?',
    'What is your race/ethnicity?',
    'Do you identify as LGBTQ+?',
    'What is your religion?',
    'Are you currently pregnant?',
    'What is your marital status?',
  ];
  for (const q of questions) {
    assert.equal(policy.classify(q), 'eeo', q);
    assert.equal(policy.mayGuess(q), false, q);
  }
});

test("a protected-characteristic question is answered only with the form's decline option", () => {
  assert.equal(policy.eeoAnswer(['Male', 'Female', 'I prefer not to say']), 'I prefer not to say');
  assert.equal(
    policy.eeoAnswer(['Yes', 'No', 'Decline to self-identify']),
    'Decline to self-identify'
  );
  assert.equal(policy.eeoAnswer(['Male', 'Female']), '');
});

test('work authorization is answered per country, not optimistically', async () => {
  assert.deepEqual(policy.authorizedCountries(), ['india']);
  assert.equal(await ask('Are you legally authorized to work in India?'), 'Yes');
  assert.equal(await ask('Are you legally authorized to work in the United States?'), 'No');
  assert.equal(await ask('Do you have the right to work in the UK?'), 'No');
  assert.equal(await ask('Are you authorized to work in Canada?'), 'No');
});

test('sponsorship is the mirror of authorization, not a blanket No', async () => {
  assert.equal(
    await ask('Will you now or in the future require sponsorship to work in the United States?'),
    'Yes'
  );
  assert.equal(await ask('Will you require visa sponsorship to work in India?'), 'No');
});

test('an unstated country falls back to the search country', async () => {
  assert.equal(await ask('Are you legally authorized to work?'), 'Yes');
  assert.equal(await ask('Will you require sponsorship?'), 'No');
});

test('legal-history questions answer No from fact and are never guessed', async () => {
  for (const q of [
    'Have you ever been convicted of a felony?',
    'Are you subject to a non-compete?',
  ]) {
    assert.equal(policy.mayGuess(q), false, q);
    assert.equal(await ask(q), 'No', q);
  }
});

test('consent boilerplate is still answered Yes so forms do not stall', async () => {
  for (const q of [
    'Do you consent to a background check?',
    'I acknowledge the privacy policy',
    'Do you agree to our terms and conditions?',
  ]) {
    assert.equal(policy.mayGuess(q), true, q);
    assert.equal(await ask(q), 'Yes', q);
  }
});

test('skill claims come from the CV — never from an optimistic default', async () => {
  assert.equal(await ask('Do you have experience with Kong Gateway?'), 'Yes');
  assert.equal(await ask('Do you have experience with Kubernetes?'), 'Yes');
  assert.equal(await ask('Do you have experience with Rust?'), 'No');
  assert.equal(await ask('Are you proficient in COBOL?'), 'No');
});

test('a vague capability question is left for the candidate, not answered either way', async () => {
  assert.equal(await ask('Do you have experience working in fast-paced environments?'), '');
});

test('degree questions respect the level actually held', async () => {
  assert.equal(await ask("Do you have a Bachelor's degree?"), 'Yes');
  assert.equal(await ask("Do you have a Master's degree?"), 'No');
  assert.equal(await ask('Do you have a PhD?'), 'No');
  assert.equal(await ask('Do you have an MBA?'), 'No');
  assert.equal(await ask('Do you have a degree?'), 'Yes');
});

test('a certification the CV does not contain is not claimed', async () => {
  assert.equal(await ask('Do you hold a PMP certification?'), 'No');
  assert.equal(await ask('Are you AWS certified?'), 'No');
  assert.equal(await ask('Do you hold a Kong Gateway Foundations certification?'), 'Yes');
  assert.equal(await ask('Do you have any relevant certifications?'), 'Yes');
});

test('relocation follows the configured location preferences', () => {
  assert.equal(policy.relocationAnswer('Are you willing to relocate to Thane?', YN), 'Yes');
  assert.equal(policy.relocationAnswer('Are you willing to relocate to Bangalore?', YN), 'No');
  assert.equal(policy.relocationAnswer('Are you willing to relocate?', YN), '');
});

test('the expected hike is derived from the configured CTCs, not hardcoded', () => {
  const from = config.currentCTC.fixed + config.currentCTC.variable;
  const to = config.expectedCTC.fixed + config.expectedCTC.variable;
  const expected = String(Math.round(((to - from) / from) * 100));
  assert.equal(
    deterministicAnswer('What percentage hike are you expecting?', 'number', []),
    expected
  );
});

test('customAnswers override every other rule, including the refusals', () => {
  const original = config.customAnswers;
  try {
    config.customAnswers = [{ match: /gender/i, answer: 'Male' }];
    assert.equal(policy.customAnswer('What is your gender?', ['Male', 'Female']), 'Male');
    config.customAnswers = [{ match: 'night shift', answer: 'No' }];
    assert.equal(policy.customAnswer('Are you willing to work night shifts?', YN), 'No');
    config.customAnswers = [{ match: 'relocate', answer: 'yes' }];
    assert.equal(policy.customAnswer('Willing to relocate?', ['Yes, I am', 'No']), 'Yes, I am');
  } finally {
    config.customAnswers = original;
  }
});

test('country detection does not confuse a company name for a work location', () => {
  assert.deepEqual(policy.countriesMentioned('Are you authorized to work in India?'), ['india']);
  assert.equal(policy.authorizationStatus('Are you authorized to work?'), 'unknown');
  assert.equal(policy.authorizationStatus('Authorized to work in the US or Canada?'), 'no');
  assert.equal(policy.authorizationStatus('Authorized to work in India or the US?'), 'yes');
});

test('attestation phrasing is consent, not a claim to hold a certification', async () => {
  assert.equal(policy.classify('I certify that the information above is accurate'), 'consent');
  assert.equal(policy.classify('Are you AWS certified?'), 'capability');
  assert.equal(await ask('I certify that the information above is accurate'), 'Yes');
  assert.equal(await ask('I hereby certify the above details'), 'Yes');
  assert.equal(await ask('Are you AWS certified?'), 'No');
});

test('plural wording is matched — forms say "veterans", not "veteran"', () => {
  assert.equal(policy.classify('Are you a protected veteran?'), 'eeo');
  assert.equal(policy.classify('Do you identify with any of these veterans groups?'), 'eeo');
  assert.equal(policy.classify('What races do you identify with?'), 'eeo');
});

test('a plain noun is not mistaken for a technology', () => {
  assert.equal(policy.looksLikeTechnology('Kubernetes'), true);
  assert.equal(policy.looksLikeTechnology('Spring Boot'), true);
  assert.equal(policy.looksLikeTechnology('distributed teams'), false);
  assert.equal(policy.looksLikeTechnology('veterans'), false);
  assert.equal(policy.looksLikeTechnology('fast-paced environments'), false);
});

test('a stated dayShiftOnly preference is not traded away for an application', async () => {
  assert.equal(config.dayShiftOnly, true);
  assert.equal(await ask('Are you willing to work night shifts?'), 'No');
  assert.equal(await ask('Are you comfortable with rotational shifts?'), 'No');
  assert.equal(await ask('Can you work US shift timings?'), 'No');
});

test('relocation to an unnamed city is left open, not answered Yes', async () => {
  assert.equal(policy.classify('Are you willing to relocate?'), 'relocation');
  assert.equal(policy.mayGuess('Are you willing to relocate?'), false);
  assert.equal(await ask('Are you willing to relocate?'), '');
  assert.equal(await ask('Are you willing to relocate to Thane?'), 'Yes');
});

test('a named technology never borrows the total-experience figure', async () => {
  const { asksForSpecificSkillExperience } = require('../answer-utils');
  assert.equal(
    asksForSpecificSkillExperience('How many years of experience do you have with Python?'),
    true
  );
  assert.equal(
    asksForSpecificSkillExperience('How many years of total work experience do you have?'),
    false
  );
  assert.equal(
    asksForSpecificSkillExperience('How many years of professional experience do you have?'),
    false
  );

  assert.equal(
    await ask('How many years of total work experience do you have?', [], 'number'),
    '4.1'
  );
  assert.equal(await ask('How many years of experience do you have with Java?', [], 'number'), '4');
  assert.equal(
    await ask('How many years of experience do you have with Python?', [], 'number'),
    ''
  );
});

test('a technology absent from the CV honestly has zero years', async () => {
  assert.equal(
    await ask('How many years of experience do you have with COBOL?', [], 'number'),
    '0'
  );
  assert.equal(
    await ask('How many years of experience do you have with Elixir?', [], 'number'),
    '0'
  );
});

test('the pronoun "us" is not the United States', async () => {
  assert.deepEqual(policy.countriesMentioned('Are you authorized to work? Let us know.'), []);
  assert.deepEqual(policy.countriesMentioned('Are you authorized to work with us?'), []);
  assert.deepEqual(policy.countriesMentioned('Tell us about your work eligibility'), []);
  assert.equal(await ask('Are you authorized to work with us?'), 'Yes');
});

test('the real abbreviation is still detected in every common spelling', async () => {
  for (const spelling of ['US', 'U.S.', 'USA', 'U.S.A.']) {
    assert.deepEqual(
      policy.countriesMentioned(`Are you authorized to work in the ${spelling}?`),
      ['united states'],
      spelling
    );
  }
  assert.equal(await ask('Are you legally authorized to work in the US?'), 'No');
  assert.equal(await ask('Do you have the right to work in the UK?'), 'No');
});

test('an abbreviation embedded in a longer word is not a country', () => {
  assert.deepEqual(policy.countriesMentioned('Do you have experience with USB drivers?'), []);
  assert.deepEqual(policy.countriesMentioned('Experience with European frameworks?'), []);
});

test('"authorized to work without sponsorship" is an authorization question', async () => {
  const q = 'Are you legally authorized to work in the United States without sponsorship?';
  assert.equal(policy.classify(q), 'work_authorization');
  assert.equal(await ask(q), 'No');

  const inIndia = 'Are you legally authorized to work in India without sponsorship?';
  assert.equal(await ask(inIndia), 'Yes');
});

test('a question about requiring sponsorship still classifies as sponsorship', async () => {
  for (const q of [
    'Will you now or in the future require sponsorship for employment visa status?',
    'Do you require visa sponsorship?',
    'Will you need sponsorship to work in the United States?',
  ]) {
    assert.equal(policy.classify(q), 'sponsorship', q);
  }
  assert.equal(await ask('Will you need sponsorship to work in the United States?'), 'Yes');
});

test('"visa" in a product name is not a sponsorship question', () => {
  assert.notEqual(
    policy.classify('Do you have experience with Visa payment integration?'),
    'sponsorship'
  );
});

test('the cover letter does not volunteer a salary by default', async () => {
  const { generateCoverLetter } = require('../resume-answers');
  const letter = await generateCoverLetter('Backend Engineer', 'Acme');
  assert.doesNotMatch(letter, /current CTC|expectation is/i);
  assert.match(letter, /notice period/i);
  assert.match(letter, /Backend Engineer/);
  assert.match(letter, /Acme/);
});

test('salary can be put back into the cover letter deliberately', async () => {
  const { generateCoverLetter } = require('../resume-answers');
  const original = config.coverLetter;
  try {
    config.coverLetter = { includeSalary: true, includeNotice: false };
    const letter = await generateCoverLetter('Backend Engineer', 'Acme');
    assert.match(letter, /current CTC/i);
    assert.doesNotMatch(letter, /notice period/i);
  } finally {
    config.coverLetter = original;
  }
});
