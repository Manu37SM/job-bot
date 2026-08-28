const test = require('node:test');
const assert = require('node:assert/strict');
const { requiredExperienceYears, assessFit } = require('../job-fit');
const config = require('../config');

test('a clearly stated minimum is read from the posting', () => {
  assert.equal(requiredExperienceYears('We need 10+ years of experience in Java.'), 10);
  assert.equal(
    requiredExperienceYears('Minimum 8 years of hands-on backend experience required.'),
    8
  );
  assert.equal(requiredExperienceYears('At least 12 years experience leading teams'), 12);
  assert.equal(requiredExperienceYears('Not less than 6 years of relevant experience'), 6);
});

test('a range contributes its floor, not its ceiling', () => {
  assert.equal(requiredExperienceYears('Looking for 3-5 years of experience.'), 3);
  assert.equal(requiredExperienceYears('5 to 8 years of relevant experience'), 5);
  assert.equal(requiredExperienceYears('2–4 years experience'), 2);
});

test('the lowest stated minimum wins when a posting lists several', () => {
  assert.equal(
    requiredExperienceYears(
      '3-5 years experience for the core stack; 8+ years experience for the lead track'
    ),
    3
  );
});

test('numbers unrelated to experience are ignored', () => {
  assert.equal(
    requiredExperienceYears('Founded 8 years ago, we are a fast-growing startup.'),
    null
  );
  assert.equal(requiredExperienceYears('Our platform serves 10+ million users.'), null);
  assert.equal(requiredExperienceYears('Series B, 200+ employees, 15 offices worldwide.'), null);
  assert.equal(requiredExperienceYears('Great opportunity for backend engineers.'), null);
});

test('a mixed posting still finds the requirement among the noise', () => {
  const jd =
    'We serve 10+ million users across 15 countries. You bring 3+ years of experience with Java.';
  assert.equal(requiredExperienceYears(jd), 3);
});

test('an unparseable posting never causes a skip', () => {
  assert.deepEqual(assessFit(''), { skip: false });
  assert.deepEqual(assessFit(null), { skip: false });
  assert.deepEqual(assessFit('Join our wonderful team!'), { skip: false });
});

test('the tolerance decides borderline cases', () => {
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

test('a company boasting about ITS OWN age is not a requirement on you', () => {
  const boilerplate = [
    'With 15+ years in the market, we serve clients across Asia.',
    'Our founders bring 20+ years to the industry.',
    'We have been delivering software for 12+ years.',
    'Celebrating 10+ years of innovation!',
    'A 25+ years legacy of engineering excellence.',
  ];
  for (const jd of boilerplate) {
    assert.equal(requiredExperienceYears(jd), null, jd);
  }
});

test('the same phrasing IS a requirement when it sits next to "experience"', () => {
  assert.equal(requiredExperienceYears('You bring 5+ years of experience with Java.'), 5);
  assert.equal(requiredExperienceYears('5+ years experience required'), 5);
  assert.equal(
    requiredExperienceYears('Candidates should have 6+ years, ideally with a backend background.'),
    6
  );
  assert.equal(requiredExperienceYears('7+ yrs in a similar role'), 7);
  assert.equal(requiredExperienceYears('At least 10 yrs required'), 10);
});

test('"yrs" counts as "years"', () => {
  assert.equal(requiredExperienceYears('Minimum 5 yrs experience'), 5);
  assert.equal(requiredExperienceYears('3-5 yrs of experience'), 3);
  assert.equal(requiredExperienceYears('12 yrs. of experience required'), 12);
});

test('the unit is not treated as evidence of an experience context', () => {
  assert.equal(requiredExperienceYears('Our founders bring 20+ yrs to the industry.'), null);
  assert.equal(requiredExperienceYears('A 25+ yrs legacy of engineering excellence.'), null);
});

test('company boilerplate does not mask a real requirement elsewhere', () => {
  const jd = [
    'With 15+ years in the market, we are a leader in fintech.',
    'We are looking for someone with 4+ years of experience in Java.',
  ].join('\n');
  assert.equal(
    requiredExperienceYears(jd),
    4,
    'the requirement must still be found among the noise'
  );
});
