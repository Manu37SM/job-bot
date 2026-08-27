const test = require('node:test');
const assert = require('node:assert/strict');

const config = require('../config');
const { current, expected } = require('../salary-helper');
const { getLocationSearchPairs } = require('../location-helper');

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

test('CTC totals add fixed and variable without float drift', () => {
  withConfig({ currentCTC: { fixed: 3.7, variable: 1 } }, () => {
    assert.equal(current.total(), 4.7);
    assert.equal(current.fixed(), 3.7);
    assert.equal(current.variable(), 1);
    // 3.7 + 1 in binary floating point is 4.7000000000000005 without rounding,
    // and that figure is typed into a salary field a recruiter reads.
    assert.equal(String(current.total()), '4.7');
  });
});

test('the full label mentions the split only when there is one', () => {
  withConfig({ currentCTC: { fixed: 3.7, variable: 1 } }, () => {
    assert.match(current.full(), /4\.7 LPA \(3\.7L fixed \+ 1L variable\)/);
  });
  withConfig({ expectedCTC: { fixed: 7, variable: 0 } }, () => {
    assert.equal(expected.full(), '7 LPA');
  });
});

test('rupee conversion is a whole number', () => {
  withConfig({ expectedCTC: { fixed: 7.5, variable: 0 } }, () => {
    assert.equal(expected.inRupees(), 750000);
    assert.ok(Number.isInteger(expected.inRupees()));
  });
});

test('missing or junk CTC values read as zero rather than NaN', () => {
  withConfig({ currentCTC: {} }, () => assert.equal(current.total(), 0));
  withConfig({ currentCTC: { fixed: 'abc', variable: null } }, () => {
    assert.equal(current.total(), 0);
    assert.ok(!Number.isNaN(current.total()), 'NaN would be typed into a salary field');
  });
});

test('search pairs cover every configured city with the right modes', () => {
  withConfig({
    locations: {
      preferredCities: ['Mumbai', 'Thane'],
      preferredCityModes: ['onsite', 'hybrid', 'remote'],
      otherCities: ['Bangalore'],
      otherCityModes: ['remote'],
    },
  }, () => {
    const pairs = getLocationSearchPairs();
    assert.equal(pairs.length, 3);
    assert.deepEqual(pairs.find((p) => p.location === 'Mumbai').workModes, ['onsite', 'hybrid', 'remote']);
    // The whole point of otherCities: those are remote-only, and applying to them
    // onsite would contradict the stated preference.
    assert.deepEqual(pairs.find((p) => p.location === 'Bangalore').workModes, ['remote']);
  });
});

test('missing mode lists fall back to sane defaults', () => {
  withConfig({ locations: { preferredCities: ['Pune'], otherCities: ['Delhi'] } }, () => {
    const pairs = getLocationSearchPairs();
    assert.deepEqual(pairs.find((p) => p.location === 'Pune').workModes, ['onsite', 'hybrid', 'remote']);
    assert.deepEqual(pairs.find((p) => p.location === 'Delhi').workModes, ['remote']);
  });
});

test('an empty location config produces no searches rather than throwing', () => {
  withConfig({ locations: {} }, () => assert.deepEqual(getLocationSearchPairs(), []));
});
