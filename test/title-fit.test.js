const test = require('node:test');
const assert = require('node:assert/strict');

const { assessTitle, titleMentions } = require('../title-fit');
const config = require('../config');

const skip = (title) => assessTitle(title).skip;

// Every title below is one this bot actually saw on a real LinkedIn search.
test('the real dry-run titles are sorted correctly', () => {
  const observed = [
    ['Junior Software Engineer', true],
    ['AI Test Engineer', true],
    ['Back End Developer', false],
    ['Sr. Software Engineer (.NET Full stack Developer)', true],
    ['Senior Full Stack Developer ( REMOTE- India)', false],
    ['Senior Frontend Developer | Discovery & Ticketing Platform', true],
    ['Senior Data Engineer - AWS', true],
    ['Senior Java Developer _ Exp: 6+ Years _ Hybrid Model', false],
  ];
  for (const [title, expected] of observed) {
    assert.equal(skip(title), expected, title);
  }
});

test('a title naming a stack that IS on the CV is kept', () => {
  // The exclusion list is checked against the CV, not applied blindly — otherwise
  // it would drift the moment the CV changes.
  for (const title of [
    'Java Developer',
    'Node.js Backend Engineer',
    'Spring Boot Microservices Developer',
    'React Developer',
    'Kafka Platform Engineer',
    'Kubernetes / Docker Engineer',
  ]) {
    assert.equal(skip(title), false, title);
  }
});

test('a plain title naming no technology is never skipped', () => {
  // The screen is exclusion-only on purpose: "Software Engineer" names nothing, and
  // requiring a match would throw away most of the market.
  for (const title of ['Software Engineer', 'Senior Software Engineer', 'Member of Technical Staff', 'Application Developer']) {
    assert.equal(skip(title), false, title);
  }
});

test('word boundaries stop false matches', () => {
  // "go developer" must not fire on "Django", ".net" must not fire on a hostname.
  assert.equal(titleMentions('Django Developer', 'go developer'), false);
  assert.equal(titleMentions('Senior Golang Engineer', 'go developer'), false);
  assert.equal(titleMentions('Kubernetes.network Engineer', '.net'), false);
  assert.equal(titleMentions('Sr. Engineer (.NET Full stack)', '.net'), true);
  assert.equal(titleMentions('Scala Engineer', 'scala'), true);
});

test('junior filtering only applies once you have experience', () => {
  assert.equal(assessTitle('Junior Software Engineer', { experienceYears: 4.1 }).skip, true);
  // Someone genuinely junior should still see junior roles.
  assert.equal(assessTitle('Junior Software Engineer', { experienceYears: 0.5 }).skip, false);
});

test('allow overrides every rule', () => {
  const original = config.titleFilters;
  try {
    config.titleFilters = { enabled: true, allow: ['frontend'] };
    assert.equal(skip('Senior Frontend Developer'), false, 'allow must win');
    config.titleFilters = { enabled: true, allow: [] };
    assert.equal(skip('Senior Frontend Developer'), true);
  } finally {
    config.titleFilters = original;
  }
});

test('extraExcludes adds to the defaults', () => {
  const original = config.titleFilters;
  try {
    config.titleFilters = { enabled: true, extraExcludes: ['blockchain'] };
    assert.equal(skip('Senior Blockchain Developer'), true);
    assert.equal(skip('Senior Java Developer'), false);
  } finally {
    config.titleFilters = original;
  }
});

test('the whole screen can be turned off', () => {
  const original = config.titleFilters;
  try {
    config.titleFilters = { enabled: false };
    assert.equal(skip('Junior .NET Data Engineer'), false);
  } finally {
    config.titleFilters = original;
  }
});

test('an empty or missing title never causes a skip', () => {
  assert.equal(skip(''), false);
  assert.equal(skip(null), false);
  assert.equal(skip('   '), false);
});
