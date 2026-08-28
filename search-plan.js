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
  } catch {}
}

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

function planSearches(platform = 'linkedin') {
  const combinations = buildCombinations();
  const offset = Number(readState().searchOffset?.[platform]) || 0;
  return rotate(combinations, offset);
}

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
