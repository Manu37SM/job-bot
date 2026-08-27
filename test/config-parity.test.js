// config.example.js is what a new user copies. It drifts silently: a feature adds a
// key to the real config, the example is forgotten, and the feature quietly uses its
// fallback for everyone else. Same for resume-profile.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const config = require('../config');
const example = require('../config.example');

// Keys the real config is allowed to have that the template need not carry.
const PRIVATE_KEYS = new Set(['linkedinUrl', 'githubUrl']);

// Free-form maps whose CONTENTS are the user's own data, not structure. Comparing
// inside them would demand the template list the same skills as the real CV.
const FREEFORM = new Set(['skillExperienceYears', 'customAnswers']);

function shape(object, prefix = '') {
  const keys = [];
  for (const [key, value] of Object.entries(object || {})) {
    const full = prefix ? `${prefix}.${key}` : key;
    keys.push(full);
    if (FREEFORM.has(key)) continue;
    const plain = value && typeof value === 'object' && !Array.isArray(value) && !(value instanceof RegExp);
    if (plain) keys.push(...shape(value, full));
  }
  return keys;
}

test('every config key exists in config.example.js', () => {
  const missing = shape(config)
    .filter((k) => !PRIVATE_KEYS.has(k))
    .filter((k) => !shape(example).includes(k));
  assert.deepEqual(missing, [], `config.example.js is missing: ${missing.join(', ')}`);
});

test('config.example.js introduces no key the real config lacks', () => {
  const extra = shape(example).filter((k) => !shape(config).includes(k));
  assert.deepEqual(extra, [], `config.example.js has keys config.js lacks: ${extra.join(', ')}`);
});

test('the example resume profile exports the same surface as the real one', () => {
  const real = Object.keys(require('../resume-profile')).sort();
  const template = Object.keys(require('../resume-profile.example')).sort();
  const missing = real.filter((k) => !template.includes(k));
  assert.deepEqual(missing, [], `resume-profile.example.js is missing: ${missing.join(', ')}`);
});

test('every npm script referenced in the README exists', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
  const scripts = Object.keys(require('../package.json').scripts);
  const referenced = [...readme.matchAll(/npm run ([a-z-]+)/g)].map((m) => m[1]);
  const unknown = [...new Set(referenced)].filter((s) => !scripts.includes(s));
  assert.deepEqual(unknown, [], `README references missing npm scripts: ${unknown.join(', ')}`);
});

test('every module the README documents actually exists', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
  const referenced = [...readme.matchAll(/`([a-z-]+\/)?([a-z-]+\.js)`/g)].map((m) => `${m[1] || ''}${m[2]}`);
  const missing = [...new Set(referenced)].filter((f) => !fs.existsSync(path.join(root, f)));
  assert.deepEqual(missing, [], `README references missing files: ${missing.join(', ')}`);
});

// Documented default values drift silently: a default changes in config.js and the
// README keeps quoting the old number. Twice already the README described behaviour
// the code no longer had.
function readConfigPath(object, dotted) {
  return dotted.split('.').reduce((node, key) => (node == null ? node : node[key]), object);
}

test('every default quoted in the README matches config.js', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
  // Matches: `key` (default 2)   `key` (10)   `search.postedWithinDays` (7)
  const pattern = /`([a-zA-Z.]+)`\s*\((?:default\s*)?(\d+)\)/g;
  const mismatches = [];

  for (const [, rawKey, rawValue] of readme.matchAll(pattern)) {
    const key = rawKey.replace(/^config\./, '');
    const actual = readConfigPath(config, key);
    if (actual === undefined) continue; // not a config key (e.g. a function name)
    if (Number(actual) !== Number(rawValue)) {
      mismatches.push(`${key}: README says ${rawValue}, config.js has ${actual}`);
    }
  }

  assert.deepEqual(mismatches, [], mismatches.join('\n'));
});

test('the README quotes at least a few real defaults', () => {
  // Guards the test above from passing because its regex matched nothing.
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf-8');
  const found = [...readme.matchAll(/`([a-zA-Z.]+)`\s*\((?:default\s*)?(\d+)\)/g)]
    .map(([, key]) => key.replace(/^config\./, ''))
    .filter((key) => readConfigPath(config, key) !== undefined);
  assert.ok(found.length >= 3, `only matched: ${found.join(', ')}`);
});

test('every mutation-test anchor still applies to the code', () => {
  // A mutant whose anchor text has moved silently stops testing whatever it was
  // there to test, and `npm run mutation` keeps reporting a perfect score. Cheap to
  // check here; a full mutation run is one test suite per mutant.
  const { MUTANTS } = require('../mutants');
  const stale = [];
  for (const [name, file, from] of MUTANTS) {
    const source = fs.readFileSync(path.join(root, file), 'utf-8');
    const occurrences = source.split(from).length - 1;
    if (occurrences !== 1) stale.push(`${name} (${file}): found ${occurrences}, expected 1`);
  }
  assert.deepEqual(stale, [], `run \`node mutants.js --anchors\`\n${stale.join('\n')}`);
});

test('the mutation suite covers every module that makes a decision', () => {
  const { MUTANTS } = require('../mutants');
  const covered = new Set(MUTANTS.map(([, file]) => file));
  const decisionModules = [
    'question-policy.js', 'answer-utils.js', 'resume-logic.js', 'field-value.js',
    'linkedin.js', 'logger.js', 'job-fit.js', 'search-filters.js',
    'failure-report.js', 'preflight.js', 'cooldown.js', 'cli.js', 'shutdown.js',
    'title-fit.js',
  ];
  const uncovered = decisionModules.filter((m) => !covered.has(m));
  assert.deepEqual(uncovered, [], `no mutant probes: ${uncovered.join(', ')}`);
});
