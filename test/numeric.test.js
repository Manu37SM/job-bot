const test = require('node:test');
const assert = require('node:assert/strict');
const { matchNumericOption, optionRange } = require('../answer-utils');

test('"Immediate" is recognised as zero — it carries no digits', () => {
  // The bug this replaces: a candidate with a 0-day notice period was matched to
  // "15 days", the nearest option that happened to contain a number.
  assert.equal(matchNumericOption('0', ['Immediate', '15 days', '30 days', '60 days']), 'Immediate');
  assert.equal(
    matchNumericOption('0', ['Immediately', '1-15 days', '16-30 days', 'More than 30 days']),
    'Immediately'
  );
  assert.equal(matchNumericOption('0', ['None', '1-2', '3-5']), 'None');
});

test('a worded quantity does not hijack a non-zero value', () => {
  assert.equal(matchNumericOption('30', ['Immediate', '30 days', '60 days']), '30 days');
  assert.equal(matchNumericOption('60', ['Immediate', '30 days', '60 days']), '60 days');
});

test('"More than N" is an open range, not the point N', () => {
  // 4.1 tied with "2-4 years" on distance and lost on iteration order before.
  assert.equal(
    matchNumericOption('4.1', ['Less than 1 year', '1-2 years', '2-4 years', 'More than 4 years']),
    'More than 4 years'
  );
  assert.equal(matchNumericOption('10', ['At least 5 years', 'Less than 5 years']), 'At least 5 years');
  assert.equal(matchNumericOption('8', ['0-3 years', '3-5 years', '5+ years']), '5+ years');
});

test('"Up to N" and "Less than N" bound from above', () => {
  assert.equal(matchNumericOption('2', ['Up to 3 years', 'Over 3 years']), 'Up to 3 years');
  assert.equal(matchNumericOption('0.5', ['Less than 1 year', '1-2 years']), 'Less than 1 year');
});

test('an option list with no quantities matches nothing', () => {
  assert.equal(matchNumericOption('0', ['Yes', 'No']), '');
  assert.equal(matchNumericOption('3', ['Mumbai', 'Pune']), '');
});

test('optionRange reads each phrasing correctly', () => {
  assert.deepEqual(optionRange('3-5 years'), { lo: 3, hi: 5 });
  assert.deepEqual(optionRange('5+ years'), { lo: 5, hi: Infinity });
  assert.deepEqual(optionRange('More than 4 years'), { lo: 4, hi: Infinity });
  assert.deepEqual(optionRange('Less than 1 year'), { lo: -Infinity, hi: 1 });
  assert.deepEqual(optionRange('Immediate'), { lo: 0, hi: 0 });
  assert.deepEqual(optionRange('30 days'), { lo: 30, hi: 30 });
  assert.equal(optionRange('Yes'), null);
});

test('a tie prefers the lower option — understating is the safer error', () => {
  assert.equal(matchNumericOption('5', ['3-5 years', '5-7 years']), '3-5 years');
});

test('salary bands resolve to the band that contains the figure', () => {
  assert.equal(matchNumericOption('7', ['0-3 LPA', '3-6 LPA', '6-9 LPA', '9+ LPA']), '6-9 LPA');
  assert.equal(matchNumericOption('4.7', ['0-3 LPA', '3-6 LPA', '6-9 LPA']), '3-6 LPA');
});

test('salaryUnit orders the candidates for an ambiguous salary field', () => {
  const { buildNumericCandidates } = require('../field-value');
  const config = require('../config');
  const original = config.salaryUnit;
  try {
    config.salaryUnit = 'lpa';
    assert.equal(buildNumericCandidates('7', 'Expected CTC', { inputType: 'number', step: '' })[0], '7');
    config.salaryUnit = 'rupees';
    assert.deepEqual(buildNumericCandidates('7', 'Expected CTC', { inputType: 'number', step: '' }), ['700000']);
    config.salaryUnit = 'auto';
    assert.equal(buildNumericCandidates('7', 'Expected CTC', { inputType: 'number', step: '' })[0], '700000');
  } finally {
    config.salaryUnit = original;
  }
});

test('an explicit unit in the label always wins over the preference', () => {
  const { buildNumericCandidates } = require('../field-value');
  // "LPA" means the LPA number itself — never a rupee conversion.
  assert.equal(buildNumericCandidates('7', 'Expected CTC in LPA', { inputType: 'number', step: '' })[0], '7');
  assert.deepEqual(buildNumericCandidates('7', 'Expected annual salary in INR', { inputType: 'number', step: '' }), ['700000']);
});

test('a field with a small max rules out the rupee reading', () => {
  const { buildNumericCandidates } = require('../field-value');
  const candidates = buildNumericCandidates('7', 'Expected CTC', { inputType: 'number', step: '', max: '100' });
  assert.ok(!candidates.includes('700000'), 'rupees cannot fit a max of 100');
  assert.equal(candidates[0], '7');
});

test('a word answer survives a numeric-sounding label', () => {
  const { isNumericQuestion } = require('../answer-utils');
  // isNumericQuestion matches the label, so these all look numeric...
  assert.equal(isNumericQuestion('Notice period', 'text'), true);
  assert.equal(isNumericQuestion('Availability', 'text'), false);
  // ...which is why smartFill must also consider whether the ANSWER is a number.
  // Guarding on the label alone blanked the field for "Immediate".
  const looksNumeric = (answer) => /^-?\d+(?:\.\d+)?$/.test(String(answer).trim().replace(/[,\s]/g, ''));
  assert.equal(looksNumeric('Immediate'), false);
  assert.equal(looksNumeric('0'), true);
  assert.equal(looksNumeric('4.1'), true);
  assert.equal(looksNumeric('7,00,000'), true);
});

test('a claim about yourself rounds down, not to nearest', () => {
  const { buildNumericCandidates } = require('../field-value');
  const numberField = { inputType: 'number', step: '' };
  // 1.7 years of tenure entered as "2" overstates it. matchNumericOption already
  // takes this view for option lists; the two must not disagree.
  assert.equal(buildNumericCandidates('1.7', 'How long have you been at your current company?', numberField)[0], '1');
  assert.equal(buildNumericCandidates('4.1', 'Total years of experience', numberField)[0], '4');
  assert.equal(buildNumericCandidates('2.9', 'Years of experience with Java', numberField)[0], '2');
});

test('the exact rupee figure beats any rounding when the field allows it', () => {
  const { buildNumericCandidates } = require('../field-value');
  const numberField = { inputType: 'number', step: '' };
  // No rounding decision is needed at all when rupees fit.
  assert.equal(buildNumericCandidates('4.7', 'Current CTC', numberField)[0], '470000');
});

test('current salary rounds down; expected salary does not', () => {
  const { buildNumericCandidates } = require('../field-value');
  const numberField = { inputType: 'number', step: '' };
  // Current CTC is a fact companies verify against payslips — overstating it by
  // rounding up is a misrepresentation. Expected CTC is an ask, not a claim.
  assert.equal(buildNumericCandidates('4.7', 'Current CTC in LPA', numberField)[0], '4');
  assert.equal(buildNumericCandidates('7.5', 'Expected CTC in LPA', numberField)[0], '8');
});

test('the exact rupee figure is still preferred where the label allows it', () => {
  const { buildNumericCandidates } = require('../field-value');
  const numberField = { inputType: 'number', step: '' };
  // No rounding needed at all when the field wants rupees.
  assert.equal(buildNumericCandidates('4.7', 'Annual salary in INR', numberField)[0], '470000');
});
