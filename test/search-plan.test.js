const os = require('os');
const path = require('path');
const fs = require('fs');

const STATE = path.join(os.tmpdir(), `job-bot-plan-${process.pid}.json`);
process.env.JOB_BOT_STATE = STATE;

const test = require('node:test');
const assert = require('node:assert/strict');
const { planSearches, buildCombinations, rotate, advanceSearchOffset } = require('../search-plan');
const config = require('../config');

test.after(() => {
  for (const f of [STATE, `${STATE}.tmp`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

const reset = () => fs.writeFileSync(STATE, '{}');

test('every position is paired with every location', () => {
  const positions = ['A', 'B'];
  const pairs = [
    { location: 'X', workModes: ['remote'] },
    { location: 'Y', workModes: ['remote'] },
  ];
  const combos = buildCombinations(positions, pairs);
  assert.equal(combos.length, 4);
  const seen = combos.map((c) => `${c.position}/${c.location}`);
  assert.deepEqual([...new Set(seen)].sort(), ['A/X', 'A/Y', 'B/X', 'B/Y']);
});

test('the role varies fastest, not the city', () => {
  // A short run should try every ROLE keyword in the first city, not the same
  // keyword across five cities — the latter wastes the whole run on one role.
  const combos = buildCombinations(
    ['FullStack', 'Backend', 'Java'],
    [{ location: 'Mumbai', workModes: [] }, { location: 'Pune', workModes: [] }]
  );
  assert.deepEqual(
    combos.slice(0, 3).map((c) => c.position),
    ['FullStack', 'Backend', 'Java']
  );
  assert.equal(combos[0].location, 'Mumbai');
  assert.equal(combos[3].location, 'Pune');
});

test('work modes travel with the location', () => {
  const combos = buildCombinations(['A'], [{ location: 'Bangalore', workModes: ['remote'] }]);
  assert.deepEqual(combos[0].workModes, ['remote']);
});

test('rotation moves the starting point without losing anything', () => {
  const list = [1, 2, 3, 4, 5];
  assert.deepEqual(rotate(list, 0), [1, 2, 3, 4, 5]);
  assert.deepEqual(rotate(list, 2), [3, 4, 5, 1, 2]);
  assert.deepEqual(rotate(list, 5), [1, 2, 3, 4, 5], 'a full lap returns to the start');
  assert.deepEqual(rotate(list, 7).sort(), list, 'nothing is dropped');
  assert.deepEqual(rotate([], 3), []);
});

test('consecutive runs start where the last one stopped', () => {
  // The whole point: with 44 combinations and a budget of 8, a run that fills up
  // in its first search must not make the next run repeat that same search.
  reset();
  const first = planSearches('linkedin');
  advanceSearchOffset('linkedin', 2);
  const second = planSearches('linkedin');

  assert.notDeepEqual(first[0], second[0], 'the next run must not repeat the same first search');
  assert.deepEqual(second[0], first[2], 'it should resume just past what was covered');
  assert.equal(second.length, first.length, 'every combination is still in the plan');
});

test('the offset wraps around rather than running off the end', () => {
  reset();
  const total = buildCombinations().length;
  advanceSearchOffset('linkedin', total + 3);
  const plan = planSearches('linkedin');
  assert.equal(plan.length, total);
  assert.deepEqual(plan[0], buildCombinations()[3]);
});

test('platforms rotate independently', () => {
  reset();
  advanceSearchOffset('linkedin', 5);
  const linkedin = planSearches('linkedin');
  const naukri = planSearches('naukri');
  assert.notDeepEqual(linkedin[0], naukri[0]);
});

test('a run that performed no searches does not advance the offset', () => {
  reset();
  const before = planSearches('linkedin');
  advanceSearchOffset('linkedin', 0);
  assert.deepEqual(planSearches('linkedin')[0], before[0]);
});

test('an empty config produces an empty plan rather than throwing', () => {
  assert.deepEqual(buildCombinations([], [{ location: 'X', workModes: [] }]), []);
  assert.deepEqual(buildCombinations(['A'], []), []);
});

test('the real config produces one entry per position per location', () => {
  const { getLocationSearchPairs } = require('../location-helper');
  assert.equal(buildCombinations().length, config.positions.length * getLocationSearchPairs().length);
});
