const test = require('node:test');
const assert = require('node:assert/strict');

const { assessTitle, titleMentions } = require('../title-fit');
const config = require('../config');

const skip = (title) => assessTitle(title).skip;

test('the real dry-run titles are sorted correctly', () => {
  const observed = [
    ['Junior Software Engineer', true],
    ['AI Test Engineer', true],
    ['Back End Developer', false],
    ['Sr. Software Engineer (.NET Full stack Developer)', true],
    ['Senior Full Stack Developer ( REMOTE- India)', false],
    ['Senior Frontend Developer | Discovery & Ticketing Platform', false],
    ['Senior Data Engineer - AWS', true],
    ['Senior Java Developer _ Exp: 6+ Years _ Hybrid Model', false],
  ];
  for (const [title, expected] of observed) {
    assert.equal(skip(title), expected, title);
  }
});

test('a title naming a stack that IS on the CV is kept', () => {
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
  for (const title of [
    'Software Engineer',
    'Senior Software Engineer',
    'Member of Technical Staff',
    'Application Developer',
  ]) {
    assert.equal(skip(title), false, title);
  }
});

test('word boundaries stop false matches', () => {
  assert.equal(titleMentions('Django Developer', 'go developer'), false);
  assert.equal(titleMentions('Senior Golang Engineer', 'go developer'), false);
  assert.equal(titleMentions('Kubernetes.network Engineer', '.net'), false);
  assert.equal(titleMentions('Sr. Engineer (.NET Full stack)', '.net'), true);
  assert.equal(titleMentions('Scala Engineer', 'scala'), true);
});

test('junior filtering only applies once you have experience', () => {
  assert.equal(assessTitle('Junior Software Engineer', { experienceYears: 4.1 }).skip, true);
  assert.equal(assessTitle('Junior Software Engineer', { experienceYears: 0.5 }).skip, false);
});

test('allow overrides every rule', () => {
  const original = config.titleFilters;
  try {
    config.titleFilters = {
      enabled: true,
      extraExcludes: ['data engineer'],
      allow: ['data engineer'],
    };
    assert.equal(skip('Senior Data Engineer - AWS'), false, 'allow must beat an exclusion');
    config.titleFilters = { enabled: true, allow: [] };
    assert.equal(skip('Senior Data Engineer - AWS'), true);
  } finally {
    config.titleFilters = original;
  }
});

test('frontend roles are kept unless you opt out', () => {
  const original = config.titleFilters;
  try {
    config.titleFilters = { enabled: true };
    for (const title of ['Frontend Developer', 'Senior Frontend Engineer', 'Front-End Developer']) {
      assert.equal(skip(title), false, title);
    }
    config.titleFilters = {
      enabled: true,
      extraExcludes: ['frontend developer', 'frontend engineer'],
    };
    assert.equal(skip('Frontend Developer'), true, 'opting out must work');
  } finally {
    config.titleFilters = original;
  }
});

test('a core role in the title beats a discipline in the domain', () => {
  for (const title of [
    'Full Stack Engineer, Machine Learning Tooling',
    'Backend Engineer, Security Team',
    'Software Engineer - Data Platform',
    'Senior Full Stack AI Engineer',
  ]) {
    assert.equal(skip(title), false, title);
  }
  for (const title of ['AI Test Engineer', 'Senior Data Engineer - AWS', 'Security Engineer']) {
    assert.equal(skip(title), true, title);
  }
});

test('a stack marker is absolute — a core role does not rescue it', () => {
  for (const title of [
    'Frontend-Focused Full Stack Developer - Angular / .NET',
    'Senior Backend Engineer - Golang',
    'Senior C# Back-End Developer',
    'ServiceNow Full Stack Developer',
    'Senior Software Engineer – Full Stack (.NET/React)',
  ]) {
    assert.equal(skip(title), true, title);
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

test('the second real dry-run batch is sorted correctly', () => {
  const observed = [
    ['Software Engineer', false],
    ['Security Engineer', true],
    ['Senior Software Engineer', false],
    ['Senior Node.js Developer', false],
    ['Core Java Developer (Oracle Database)', false],
    ['Web Developer', false],
    ['Technical Leader (Fullstack Backend focused)', false],
    ['SASE Solutions Engineer', true],
    ['Senior Ruby on Rails Developer (IoT Integrations)', true],
    ['PowerBuilder Developer', true],
    ['AI/ML Engineer', true],
  ];
  for (const [title, expected] of observed) {
    assert.equal(skip(title), expected, title);
  }
});

test('a backend role in a security domain is still your job', () => {
  for (const title of [
    'Backend Engineer, Security Team',
    'Java Developer - Banking Security Domain',
    'Solutions Architect - Java',
    'Senior Engineer, Network Services Platform',
  ]) {
    assert.equal(skip(title), false, title);
  }
});

test('pre-sales roles that carry the word "engineer" are excluded', () => {
  for (const title of ['Solutions Engineer', 'Sales Engineer', 'Pre-Sales Engineer']) {
    assert.equal(skip(title), true, title);
  }
});

test('enterprise platforms are treated like languages', () => {
  for (const title of [
    'Progress Developer II',
    'MuleSoft Integration Developer',
    'Senior Informatica Developer',
    'Software Engineer : Oracle Integration Cloud(OIC) Consultant',
  ]) {
    assert.equal(skip(title), true, title);
  }
});

test('platform names are matched as phrases, not as English words', () => {
  for (const title of [
    'Java Developer - Progress tracking platform',
    'Backend Engineer, Dynamics Team',
    'Full Stack Developer, Growth & Progress',
  ]) {
    assert.equal(skip(title), false, title);
  }
});
