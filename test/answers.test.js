const test = require('node:test');
const assert = require('node:assert/strict');

const { deterministicAnswer, isNumericQuestion, normalizeAnswer } = require('../answer-utils');
const { buildNumericCandidates, isIntegerOnly } = require('../field-value');
const { getLinkedInJobId } = require('../linkedin');
const { answerQuestion, generateCoverLetter } = require('../resume-answers');
const profile = require('../resume-profile');

test('number inputs without an explicit step are integer-only', () => {
  assert.equal(isIntegerOnly({ inputType: 'number', step: '' }), true);
  assert.equal(isIntegerOnly({ inputType: 'number', step: 'any' }), false);
  assert.equal(isIntegerOnly({ inputType: 'number', step: '0.1' }), false);
});

test('decimal experience prefers integers for integer-only fields, decimal as last resort', () => {
  // Integer variants are tried first since a plain step=1 field rejects decimals;
  // the raw decimal is kept as a fallback because some "number" inputs accept it
  // anyway (browser step-validation is inconsistent).
  assert.deepEqual(
    buildNumericCandidates('4.1', 'Years of experience', {
      inputType: 'number',
      step: '',
    }),
    ['4', '5', '4.1']
  );
});

test('salary is converted to rupees only when the label asks for INR', () => {
  assert.deepEqual(
    buildNumericCandidates('4.7', 'Current CTC in LPA', {
      inputType: 'number',
      step: '',
    }),
    ['5', '4']
  );
  assert.deepEqual(
    buildNumericCandidates('4.7', 'Current annual salary in INR', {
      inputType: 'number',
      step: '',
    }),
    ['470000']
  );
});

test('Yes is never accepted as a numeric answer', () => {
  assert.equal(normalizeAnswer('Yes', 'number'), '');
  assert.deepEqual(
    buildNumericCandidates('Yes', 'Years of experience', { inputType: 'number' }),
    []
  );
});

test('known candidate facts are answered without an API call', () => {
  assert.equal(deterministicAnswer('How many years of experience do you have?', 'number'), '4.1');
  assert.equal(deterministicAnswer('What is your notice period in days?', 'number'), '0');
  assert.equal(
    deterministicAnswer('Are you available to join immediately?', 'radio', ['Yes', 'No']),
    'Yes'
  );
});

test('numeric-looking text questions are treated as numeric', () => {
  assert.equal(isNumericQuestion('How many years of Java experience?', 'text'), true);
  assert.equal(isNumericQuestion('Why are you interested in this role?', 'text'), false);
});

test('unknown skill-specific experience is not replaced with total experience', () => {
  assert.equal(deterministicAnswer('How many years of Angular experience?', 'number'), '');
});

test('known skill-specific experience uses configured skill years', () => {
  assert.equal(deterministicAnswer('How many years of Java experience?', 'number'), '4');
});

test('linkedin job id can be read from currentJobId on search urls', () => {
  assert.equal(
    getLinkedInJobId(
      'https://www.linkedin.com/jobs/search/?currentJobId=4429095261&f_E=2%2C3%2C4&keywords=Backend%20Developer'
    ),
    '4429095261'
  );
});

test('provider answers must match a supplied option', () => {
  assert.equal(normalizeAnswer('Yes, I am', 'radio', ['Yes', 'No']), 'Yes');
  assert.equal(normalizeAnswer('Maybe', 'radio', ['Yes', 'No']), '');
});

test('resume-answers never leaves a yes/no field blank (no AI, all local/CV-based)', async () => {
  assert.equal(
    await answerQuestion('Do you have experience with Kong Gateway?', 'Backend Dev', 'Acme', 'radio', [
      'Yes',
      'No',
    ]),
    'Yes'
  );
  assert.equal(
    await answerQuestion('Have you ever been convicted of a felony?', 'Backend Dev', 'Acme', 'radio', [
      'Yes',
      'No',
    ]),
    'No'
  );
  assert.equal(
    await answerQuestion('I consent to a background check', 'Backend Dev', 'Acme', 'radio', [
      'Yes',
      'No',
    ]),
    'Yes'
  );
  assert.equal(
    await answerQuestion(
      'Will you now or in the future require visa sponsorship?',
      'Backend Dev',
      'Acme',
      'radio',
      ['Yes', 'No']
    ),
    'No'
  );
  const shift = await answerQuestion('Select your shift preference', 'Backend Dev', 'Acme', 'select', [
    'Morning',
    'Evening',
  ]);
  assert.ok(['Morning', 'Evening'].includes(shift), 'ambiguous option questions still get an answer');
});

test('resume-answers builds textarea and cover letter content from the CV, not an API call', async () => {
  const about = await answerQuestion('Tell us about yourself', 'Backend Dev', 'Acme', 'textarea', []);
  assert.equal(about, profile.summary);

  const letter = await generateCoverLetter('Backend Developer', 'Acme');
  assert.ok(letter.includes('Backend Developer'));
  assert.ok(letter.includes('Acme'));
});

test('resume-profile detects skills mentioned in the CV', () => {
  assert.equal(profile.mentionsSkill('Kong Gateway'), true);
  assert.equal(profile.mentionsSkill('Ruby on Rails'), false);
});
