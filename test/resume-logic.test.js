const test = require('node:test');
const assert = require('node:assert/strict');

const profile = require('../resume-profile');
const example = require('../resume-profile.example');
const { buildProfile } = require('../resume-logic');
const { isTenureQuestion } = require('../question-policy');
const { answerQuestion } = require('../resume-answers');
const config = require('../config');

const YN = ['Yes', 'No'];
const ask = (q, options = [], type = 'number') => answerQuestion(q, '', '', type, options);

test('the template and the real profile share one implementation', () => {
  assert.deepEqual(Object.keys(profile).sort(), Object.keys(example).sort());
  assert.equal(example.answerFromResume("Do you have a Master's degree?", 'radio', YN), 'No');
  assert.equal(example.answerFromResume('Do you hold a PMP certification?', 'radio', YN), 'No');
});

test('buildProfile closes over the data it is given', () => {
  const other = buildProfile({
    skills: ['Erlang'],
    certifications: [],
    education: { degree: 'PhD in Physics', degreeLevel: 'phd' },
    employers: [{ company: 'Acme', period: 'January 2020 – January 2024' }],
    summary: 'A physicist.',
  });
  assert.equal(other.answerFromResume('Do you have experience with Erlang?', 'radio', YN), 'Yes');
  assert.equal(other.answerFromResume("Do you have a Master's degree?", 'radio', YN), 'Yes');
  assert.equal(other.tenureYears(other.employers[0]), 4);
  assert.equal(profile.answerFromResume('Do you have experience with Erlang?', 'radio', YN), 'No');
});

test('tenure is read from the employment dates, not the whole career', () => {
  assert.equal(profile.tenureYears({ period: 'September 2024 – June 2026' }), 1.7);
  assert.equal(profile.tenureYears({ period: '2019 - 2021' }), 2.9);
  assert.equal(profile.tenureYears({ period: 'nonsense' }), null);
  assert.ok(profile.tenureYears({ period: 'July 2022 – Present' }) > 3);
});

test('a tenure question is not answered with total career experience', async () => {
  const tenure = String(profile.tenureYears(profile.employers[0]));
  assert.equal(await ask('How long have you been at your current company?'), tenure);
  assert.equal(await ask('What is your tenure at your current organisation?'), tenure);
  assert.notEqual(tenure, String(config.experienceYears));
});

test('a career-length question is still answered with total experience', async () => {
  assert.equal(isTenureQuestion('How long have you been working in software?'), false);
  assert.equal(
    await ask('How many years of total work experience do you have?'),
    String(config.experienceYears)
  );
});

test('"how many years of X" is never answered with a yes/no', async () => {
  for (const skill of ['Kubernetes', 'Kafka', 'Docker', 'PostgreSQL', 'Angular']) {
    const answer = await ask(`How many years of experience do you have with ${skill}?`);
    assert.doesNotMatch(String(answer), /^(yes|no)$/i, `${skill} answered "${answer}"`);
  }
});

test('a configured skill still answers with its number', async () => {
  assert.equal(await ask('How many years of experience do you have with Java?'), '4');
});

test('an opt-in fallback fills unconfigured skill years, capped at total experience', async () => {
  const original = config.skillExperienceFallbackYears;
  try {
    config.skillExperienceFallbackYears = 2;
    assert.equal(await ask('How many years of experience do you have with Kubernetes?'), '2');
    config.skillExperienceFallbackYears = 99;
    assert.equal(
      await ask('How many years of experience do you have with Kubernetes?'),
      String(config.experienceYears)
    );
  } finally {
    config.skillExperienceFallbackYears = original;
  }
});

test('yes/no skill questions are unaffected by the quantity guard', async () => {
  assert.equal(await ask('Do you have experience with Kubernetes?', YN, 'radio'), 'Yes');
  assert.equal(await ask('Are you proficient in Kafka?', YN, 'radio'), 'Yes');
  assert.equal(await ask('Do you have experience with Rust?', YN, 'radio'), 'No');
});
