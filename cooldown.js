const fs = require('fs');
const path = require('path');

const STATE_FILE = process.env.JOB_BOT_STATE
  ? path.resolve(process.env.JOB_BOT_STATE)
  : path.join(__dirname, '.bot-state.json');

const DEFAULT_HOLD_HOURS = 24;

function readState() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function writeState(state) {
  const tmp = `${STATE_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

function holdHours() {
  try {
    const configured = Number(require('./config').cooldownHoursAfterThrottle);
    return Number.isFinite(configured) && configured >= 0 ? configured : DEFAULT_HOLD_HOURS;
  } catch {
    return DEFAULT_HOLD_HOURS;
  }
}

function recordThrottle(platform, message, now = Date.now()) {
  const state = readState();
  state.throttle = state.throttle || {};
  state.throttle[platform] = {
    at: new Date(now).toISOString(),
    until: new Date(now + holdHours() * 3600000).toISOString(),
    message: String(message || '').slice(0, 300),
  };
  writeState(state);
  return state.throttle[platform];
}

function activeHold(platform, now = Date.now()) {
  const entry = readState().throttle?.[platform];
  if (!entry?.until) return null;
  const until = Date.parse(entry.until);
  if (!Number.isFinite(until) || until <= now) return null;
  return {
    until: entry.until,
    hoursLeft: Math.ceil((until - now) / 3600000),
    message: entry.message || '',
    at: entry.at,
  };
}

function clearHold(platform) {
  const state = readState();
  if (state.throttle) delete state.throttle[platform];
  writeState(state);
}

module.exports = { recordThrottle, activeHold, clearHold, STATE_FILE, DEFAULT_HOLD_HOURS };
