const test = require('node:test');
const assert = require('node:assert/strict');

const { deterministicAnswer, isNumericQuestion, normalizeAnswer } = require('../answer-utils');
const { buildNumericCandidates, isIntegerOnly } = require('../field-value');

test('number inputs without an explicit step are integer-only', () => {
  assert.equal(isIntegerOnly({ inputType: 'number', step: '' }), true);
  assert.equal(isIntegerOnly({ inputType: 'number', step: 'any' }), false);
  assert.equal(isIntegerOnly({ inputType: 'number', step: '0.1' }), false);
});

test('decimal experience becomes an integer for integer-only fields', () => {
  assert.deepEqual(
    buildNumericCandidates('4.1', 'Years of experience', {
      inputType: 'number',
      step: '',
    }),
    ['4', '5']
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

test('provider answers must match a supplied option', () => {
  assert.equal(normalizeAnswer('Yes, I am', 'radio', ['Yes', 'No']), 'Yes');
  assert.equal(normalizeAnswer('Maybe', 'radio', ['Yes', 'No']), '');
});
