// A persistent hold after LinkedIn rate-limits the account.
//
// The bot already stops the moment it sees the "we've briefly paused Easy Apply"
// notice. What it could not do is stop the NEXT run, ten minutes later — and
// running straight back into a safeguard is exactly how a temporary pause becomes
// a lasting restriction. This records the event on disk so the hold survives the
// process ending.
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

// Called when a run aborts on LinkedIn's rate-limit notice.
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

// Returns null when it is fine to run, or { until, hoursLeft, message } when a
// hold is still in force.
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
