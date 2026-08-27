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

test('a company boasting about ITS OWN age is not a requirement on you', () => {
  // These are the cases the proximity window exists for: the pattern matches
  // ("15+ years") but the sentence is about the company, not the candidate.
  // Without the check every one of these would skip a perfectly good job.
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
  // The mirror of the case above — the proximity window must not be so tight that
  // it throws away real requirements.
  assert.equal(requiredExperienceYears('You bring 5+ years of experience with Java.'), 5);
  assert.equal(requiredExperienceYears('5+ years experience required'), 5);
  assert.equal(requiredExperienceYears('Candidates should have 6+ years, ideally with a backend background.'), 6);
  assert.equal(requiredExperienceYears('7+ yrs in a similar role'), 7);
  assert.equal(requiredExperienceYears('At least 10 yrs required'), 10);
});

test('"yrs" counts as "years"', () => {
  // Postings use the shorthand at least as often as the full word, especially
  // Indian ones. "Minimum 12 yrs experience" matched nothing at all, so a posting
  // written that way sailed through the screen as if it stated no requirement.
  assert.equal(requiredExperienceYears('Minimum 5 yrs experience'), 5);
  assert.equal(requiredExperienceYears('3-5 yrs of experience'), 3);
  assert.equal(requiredExperienceYears('12 yrs. of experience required'), 12);
});

test('the unit is not treated as evidence of an experience context', () => {
  // "yrs" was in the proximity word list as a proxy for "this is about
  // experience". Once "yrs" also became a recognised unit it satisfied the check
  // on its own, and company boilerplate written with the shorthand slipped past.
  assert.equal(requiredExperienceYears('Our founders bring 20+ yrs to the industry.'), null);
  assert.equal(requiredExperienceYears('A 25+ yrs legacy of engineering excellence.'), null);
});

test('company boilerplate does not mask a real requirement elsewhere', () => {
  const jd = [
    'With 15+ years in the market, we are a leader in fintech.',
    'We are looking for someone with 4+ years of experience in Java.',
  ].join('\n');
  assert.equal(requiredExperienceYears(jd), 4, 'the requirement must still be found among the noise');
});
