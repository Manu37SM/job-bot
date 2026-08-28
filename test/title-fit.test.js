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
    // Frontend is kept by default: the CV lists React, Angular and Next.js, and 8
    // of the 291 real applications in the log were frontend roles.
    ['Senior Frontend Developer | Discovery & Ticketing Platform', false],
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
    config.titleFilters = { enabled: true, extraExcludes: ['data engineer'], allow: ['data engineer'] };
    assert.equal(skip('Senior Data Engineer - AWS'), false, 'allow must beat an exclusion');
    config.titleFilters = { enabled: true, allow: [] };
    assert.equal(skip('Senior Data Engineer - AWS'), true);
  } finally {
    config.titleFilters = original;
  }
});

test('frontend roles are kept unless you opt out', () => {
  // The CV lists React, Angular, Next.js, HTML and CSS, and 8 of the 291 real
  // applications were frontend roles. Excluding them by default would override the
  // candidate's own revealed preference on ambiguous evidence.
  const original = config.titleFilters;
  try {
    config.titleFilters = { enabled: true };
    for (const title of ['Frontend Developer', 'Senior Frontend Engineer', 'Front-End Developer']) {
      assert.equal(skip(title), false, title);
    }
    config.titleFilters = { enabled: true, extraExcludes: ['frontend developer', 'frontend engineer'] };
    assert.equal(skip('Frontend Developer'), true, 'opting out must work');
  } finally {
    config.titleFilters = original;
  }
});

test('a core role in the title beats a discipline in the domain', () => {
  // "Full Stack Engineer, Machine Learning Tooling" is a full-stack job at an ML
  // company. Blocking it on the words "machine learning" threw away a real match:
  // the role is the head of the title, the discipline is the domain after it.
  for (const title of [
    'Full Stack Engineer, Machine Learning Tooling',
    'Backend Engineer, Security Team',
    'Software Engineer - Data Platform',
    'Senior Full Stack AI Engineer',
  ]) {
    assert.equal(skip(title), false, title);
  }
  // With no core role in the title, the discipline still decides.
  for (const title of ['AI Test Engineer', 'Senior Data Engineer - AWS', 'Security Engineer']) {
    assert.equal(skip(title), true, title);
  }
});

test('a stack marker is absolute — a core role does not rescue it', () => {
  // ".NET Full Stack Developer" is a .NET job however it is worded. These are all
  // real titles this candidate actually applied to.
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
  // A second live run put "Security Engineer" and "SASE Solutions Engineer" in the
  // apply list — both security/network roles for a backend API developer.
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
  // The exclusions must name the ROLE, not merely mention the word. Plenty of
  // backend work is in security, banking or networking domains.
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
  // "Progress Developer II" was attempted 12 times in the real log, and
  // Progress/OpenEdge is nowhere on the CV.
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
  // "progress" and "dynamics" are ordinary words; excluding them outright would
  // throw away real jobs.
  for (const title of [
    'Java Developer - Progress tracking platform',
    'Backend Engineer, Dynamics Team',
    'Full Stack Developer, Growth & Progress',
  ]) {
    assert.equal(skip(title), false, title);
  }
});
