const test = require('node:test');
const assert = require('node:assert/strict');

const { buildSearchUrl, levelsForExperience, experienceLevelParam, postedWithinParam } = require('../search-filters');
const config = require('../config');

function withConfig(patch, fn) {
  const saved = {};
  for (const key of Object.keys(patch)) saved[key] = config[key];
  Object.assign(config, patch);
  try {
    return fn();
  } finally {
    Object.assign(config, saved);
  }
}

test('experience levels are derived from the career, not hard-coded', () => {
  // f_E=2,3,4 for everyone meant a mid-career candidate got Entry-level postings.
  assert.deepEqual(levelsForExperience(0.5), ['internship', 'entry']);
  assert.deepEqual(levelsForExperience(2), ['entry', 'associate']);
  assert.deepEqual(levelsForExperience(4.1), ['associate', 'mid-senior']);
  assert.deepEqual(levelsForExperience(9), ['mid-senior', 'director']);
  assert.deepEqual(levelsForExperience(15), ['director', 'executive']);
});

test('the bands overlap on purpose', () => {
  // A 4-year candidate is a plausible fit for both Associate and Mid-Senior, and
  // excluding either loses real matches.
  for (const years of [0.5, 2, 4.1, 9, 15]) {
    assert.equal(levelsForExperience(years).length, 2, `${years} should span two bands`);
  }
});

test('a junk experience value falls back rather than producing an empty filter', () => {
  assert.deepEqual(levelsForExperience(undefined), ['associate', 'mid-senior']);
  assert.deepEqual(levelsForExperience(-5), ['associate', 'mid-senior']);
});

test('an explicit level list overrides the derivation', () => {
  withConfig({ search: { experienceLevels: ['entry', 'associate'] } }, () => {
    assert.equal(experienceLevelParam(), '2,3');
  });
  withConfig({ search: { experienceLevels: ['nonsense'] } }, () => {
    // An unrecognised name must not silently produce an empty filter, which would
    // widen the search to everything.
    assert.equal(experienceLevelParam(), '');
  });
});

test('the date filter converts days to LinkedIn seconds', () => {
  withConfig({ search: { postedWithinDays: 7 } }, () => assert.equal(postedWithinParam(), 'r604800'));
  withConfig({ search: { postedWithinDays: 1 } }, () => assert.equal(postedWithinParam(), 'r86400'));
  withConfig({ search: { postedWithinDays: null } }, () => assert.equal(postedWithinParam(), ''));
  withConfig({ search: { postedWithinDays: 0 } }, () => assert.equal(postedWithinParam(), ''));
});

test('the URL keeps the encoding that already works', () => {
  const url = buildSearchUrl({ position: 'FullStack Developer', location: 'Mumbai (All Areas)', workModes: ['onsite'] });
  // Spaces as %20 and literal commas, not URLSearchParams' "+" and "%2C".
  assert.match(url, /keywords=FullStack%20Developer/);
  assert.match(url, /location=Mumbai%20\(All%20Areas\)/);
  assert.doesNotMatch(url, /\+/);
  assert.match(url, /f_LF=f_AL/, 'Easy Apply filter must always be present');
});

test('work modes and job types map to LinkedIn codes', () => {
  const url = buildSearchUrl({ position: 'x', location: 'y', workModes: ['onsite', 'hybrid', 'remote'] });
  assert.match(url, /f_WT=1,3,2/);
  assert.match(url, /f_JT=F/);
});

test('an empty work-mode list omits the filter instead of sending an empty one', () => {
  const url = buildSearchUrl({ position: 'x', location: 'y', workModes: [] });
  assert.doesNotMatch(url, /f_WT=/);
});
