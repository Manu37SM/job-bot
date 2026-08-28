const test = require('node:test');
const assert = require('node:assert/strict');

const { collectIssues } = require('../preflight');
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

const messages = () =>
  collectIssues()
    .map((i) => `${i.level}: ${i.message}`)
    .join('\n');
const errors = () => collectIssues().filter((i) => i.level === 'error');

test('the shipped config passes with no errors', () => {
  assert.deepEqual(errors(), [], messages());
});

test('a missing resume is an error, not a silent skip', () => {
  withConfig({ resumePath: './does-not-exist.pdf' }, () => {
    assert.match(messages(), /Resume not found/);
    assert.ok(errors().length > 0);
  });
});

test('an expected CTC below the current one is flagged', () => {
  withConfig(
    { currentCTC: { fixed: 10, variable: 0 }, expectedCTC: { fixed: 5, variable: 0 } },
    () => {
      assert.match(messages(), /below currentCTC/);
    }
  );
});

test('a skill claiming more years than the total career is flagged', () => {
  withConfig({ experienceYears: 4.1, skillExperienceYears: { Java: 12 } }, () => {
    assert.match(messages(), /exceeds your total experience/);
  });
});

test('a non-numeric skill year count is an error', () => {
  withConfig({ skillExperienceYears: { Java: 'four' } }, () => {
    assert.match(messages(), /is not a number/);
    assert.ok(errors().length > 0);
  });
});

test('a customAnswers entry that can never match is an error', () => {
  withConfig({ customAnswers: [{ match: 42, answer: 'Yes' }] }, () => {
    assert.match(messages(), /must be a string or a RegExp/);
    assert.ok(errors().length > 0);
  });
  withConfig({ customAnswers: 'not an array' }, () => {
    assert.match(messages(), /must be an array/);
  });
});

test('a blank customAnswers entry is a warning, not an error', () => {
  withConfig({ customAnswers: [{ match: /gender/i, answer: '' }] }, () => {
    assert.match(messages(), /empty answer/);
    assert.deepEqual(errors(), []);
  });
});

test('an empty authorizedCountries list is an error — it would deny everything', () => {
  withConfig({ authorization: { authorizedCountries: [] } }, () => {
    assert.match(messages(), /would answer No/);
    assert.ok(errors().length > 0);
  });
});

test('reckless pacing is flagged before a browser opens', () => {
  withConfig({ pacing: { minSecondsBetweenApps: 1, maxSecondsBetweenApps: 2 } }, () => {
    assert.match(messages(), /look automated/);
  });
  withConfig({ pacing: { minSecondsBetweenApps: 200, maxSecondsBetweenApps: 100 } }, () => {
    assert.match(messages(), /greater than the max/);
    assert.ok(errors().length > 0);
  });
});

test('a perRun above perDay is flagged as misleading', () => {
  withConfig({ maxApplications: { linkedin: { perRun: 50, perDay: 10, lifetime: 500 } } }, () => {
    assert.match(messages(), /perRun exceeds perDay/);
  });
});

test('empty positions or locations are errors', () => {
  withConfig({ positions: [] }, () => assert.match(messages(), /positions is empty/));
  withConfig({ locations: { preferredCities: [], otherCities: [] } }, () =>
    assert.match(messages(), /No search locations/)
  );
});

test('a resume summary contradicting config.experienceYears is flagged', () => {
  withConfig({ experienceYears: 9 }, () => {
    assert.match(messages(), /resume summary says .* but config\.experienceYears is 9/);
  });
});

test('a summary within a year of the config figure is not flagged', () => {
  const profile = require('../resume-profile');
  const claimed = Number(String(profile.summary).match(/(\d+(?:\.\d+)?)\s*\+?\s*years?/i)?.[1]);
  withConfig({ experienceYears: claimed }, () => {
    assert.doesNotMatch(messages(), /resume summary says/);
  });
});

test('an unknown experience level is an error, not a silently empty filter', () => {
  withConfig({ search: { experienceLevels: ['senior-ish'] } }, () => {
    assert.match(messages(), /Unknown search\.experienceLevels/);
    assert.ok(errors().length > 0);
  });
  withConfig({ search: { experienceLevels: 'mid-senior' } }, () => {
    assert.match(messages(), /must be an array/);
  });
});

test('valid search settings pass', () => {
  withConfig(
    { search: { experienceLevels: ['associate', 'mid-senior'], postedWithinDays: 7 } },
    () => {
      assert.deepEqual(errors(), [], messages());
    }
  );
});

test('a nonsensical date window is caught', () => {
  withConfig({ search: { postedWithinDays: -3 } }, () => {
    assert.match(messages(), /must be a positive number or null/);
  });
  withConfig({ search: { postedWithinDays: 0.5 } }, () => {
    assert.match(messages(), /very narrow window/);
  });
});
