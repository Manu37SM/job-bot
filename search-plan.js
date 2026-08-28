// Decides which (position, location) searches a run performs, and in what order.
//
// The loop used to be `for each position { for each location { ... } }`, exiting as
// soon as the run's application budget was spent. With 4 positions, 11 location
// pairs and a budget of 8, that means 44 possible searches of which the FIRST one
// almost always filled the budget on its own. Every "Java Developer" search and
// every Bangalore/Pune search had effectively never run — the bot was applying to
// one narrow slice of the market, over and over, and the log shows it.
//
// Two changes: the combinations are interleaved so consecutive searches vary the
// ROLE rather than nudging the city, and the starting point rotates between runs
// so a different slice is reached each time.
const fs = require('fs');
const path = require('path');
const config = require('./config');
const { getLocationSearchPairs } = require('./location-helper');

const STATE_FILE = process.env.JOB_BOT_STATE
  ? path.resolve(process.env.JOB_BOT_STATE)
  : path.join(__dirname, '.bot-state.json');

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  try {
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch {
    // Rotation is an optimisation, not a correctness requirement.
  }
}

// Position varies fastest: within a city, every role keyword is tried before the
// search moves on. Trying the same keyword across five cities first would waste a
// short run on one role.
function buildCombinations(positions = config.positions || [], pairs = getLocationSearchPairs()) {
  if (!positions.length || !pairs.length) return [];
  const combinations = [];
  for (let i = 0; i < positions.length * pairs.length; i++) {
    const { location, workModes } = pairs[Math.floor(i / positions.length) % pairs.length];
    combinations.push({ position: positions[i % positions.length], location, workModes });
  }
  return combinations;
}

function rotate(list, offset) {
  if (!list.length) return [];
  const start = ((offset % list.length) + list.length) % list.length;
  return [...list.slice(start), ...list.slice(0, start)];
}

// The plan for this run: every combination, starting from wherever the last run
// left off. A run still stops when its budget is spent — the point is that the
// next run starts somewhere new.
function planSearches(platform = 'linkedin') {
  const combinations = buildCombinations();
  const offset = Number(readState().searchOffset?.[platform]) || 0;
  return rotate(combinations, offset);
}

// Called after a run with how many searches it actually got through, so the next
// run picks up beyond them rather than repeating the same ones.
function advanceSearchOffset(platform, searchesPerformed) {
  const total = buildCombinations().length;
  if (!total || !searchesPerformed) return;
  const state = readState();
  state.searchOffset = state.searchOffset || {};
  const current = Number(state.searchOffset[platform]) || 0;
  state.searchOffset[platform] = (current + searchesPerformed) % total;
  writeState(state);
}

module.exports = { planSearches, buildCombinations, rotate, advanceSearchOffset, STATE_FILE };
