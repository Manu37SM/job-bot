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
