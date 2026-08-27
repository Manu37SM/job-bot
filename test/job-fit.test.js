const test = require('node:test');
const assert = require('node:assert/strict');
const { requiredExperienceYears, assessFit } = require('../job-fit');
const config = require('../config');

test('a clearly stated minimum is read from the posting', () => {
  assert.equal(requiredExperienceYears('We need 10+ years of experience in Java.'), 10);
  assert.equal(requiredExperienceYears('Minimum 8 years of hands-on backend experience required.'), 8);
  assert.equal(requiredExperienceYears('At least 12 years experience leading teams'), 12);
  assert.equal(requiredExperienceYears('Not less than 6 years of relevant experience'), 6);
});

test('a range contributes its floor, not its ceiling', () => {
  assert.equal(requiredExperienceYears('Looking for 3-5 years of experience.'), 3);
  assert.equal(requiredExperienceYears('5 to 8 years of relevant experience'), 5);
  assert.equal(requiredExperienceYears('2–4 years experience'), 2);
});

test('the lowest stated minimum wins when a posting lists several', () => {
  // A posting open to 3 years for the core role is open to a 4-year candidate,
  // whatever the lead track asks for.
  assert.equal(
    requiredExperienceYears('3-5 years experience for the core stack; 8+ years experience for the lead track'),
    3
  );
});

test('numbers unrelated to experience are ignored', () => {
  // The whole reason for the proximity window.
  assert.equal(requiredExperienceYears('Founded 8 years ago, we are a fast-growing startup.'), null);
  assert.equal(requiredExperienceYears('Our platform serves 10+ million users.'), null);
  assert.equal(requiredExperienceYears('Series B, 200+ employees, 15 offices worldwide.'), null);
  assert.equal(requiredExperienceYears('Great opportunity for backend engineers.'), null);
});

test('a mixed posting still finds the requirement among the noise', () => {
  const jd = 'We serve 10+ million users across 15 countries. You bring 3+ years of experience with Java.';
  assert.equal(requiredExperienceYears(jd), 3);
});

test('an unparseable posting never causes a skip', () => {
  assert.deepEqual(assessFit(''), { skip: false });
  assert.deepEqual(assessFit(null), { skip: false });
  assert.deepEqual(assessFit('Join our wonderful team!'), { skip: false });
});

test('the tolerance decides borderline cases', () => {
  // 4.1 years of experience, tolerance 2 → anything up to 6.1 is worth applying to.
  assert.equal(assessFit('We need 6+ years of experience.', { experienceYears: 4.1 }).skip, false);
  assert.equal(assessFit('We need 7+ years of experience.', { experienceYears: 4.1 }).skip, true);
});

test('the screen can be turned off entirely', () => {
  const original = config.fit;
  try {
    config.fit = { skipOverqualifiedPostings: false };
    assert.equal(assessFit('We need 20+ years of experience.').skip, false);
  } finally {
    config.fit = original;
  }
});

test('an absurd figure is not treated as a requirement', () => {
  assert.equal(requiredExperienceYears('50 years of experience in the industry'), null);
});
