const os = require('os');
const path = require('path');
const fs = require('fs');

const STATE = path.join(os.tmpdir(), `job-bot-state-${process.pid}.json`);
process.env.JOB_BOT_STATE = STATE;

const test = require('node:test');
const assert = require('node:assert/strict');
const cooldown = require('../cooldown');

test.after(() => {
  for (const f of [STATE, `${STATE}.tmp`]) if (fs.existsSync(f)) fs.unlinkSync(f);
});

test('a fresh install has no hold', () => {
  if (fs.existsSync(STATE)) fs.unlinkSync(STATE);
  assert.equal(cooldown.activeHold('linkedin'), null);
});

test('a rate limit puts the next run on hold', () => {
  const now = Date.parse('2026-08-27T10:00:00.000Z');
  cooldown.recordThrottle('linkedin', "We've briefly paused Easy Apply", now);

  const hold = cooldown.activeHold('linkedin', now + 3600000); // one hour later
  assert.ok(hold, 'the hold must survive the process that recorded it');
  assert.equal(hold.hoursLeft, 23);
  assert.match(hold.message, /briefly paused/);
});

test('the hold lifts on its own once it expires', () => {
  const now = Date.parse('2026-08-27T10:00:00.000Z');
  cooldown.recordThrottle('linkedin', 'paused', now);
  assert.equal(cooldown.activeHold('linkedin', now + 25 * 3600000), null);
});

test('a hold on one platform does not block another', () => {
  const now = Date.now();
  cooldown.recordThrottle('linkedin', 'paused', now);
  assert.ok(cooldown.activeHold('linkedin', now));
  assert.equal(cooldown.activeHold('naukri', now), null);
});

test('a hold can be cleared deliberately', () => {
  const now = Date.now();
  cooldown.recordThrottle('linkedin', 'paused', now);
  cooldown.clearHold('linkedin');
  assert.equal(cooldown.activeHold('linkedin', now), null);
});

test('a corrupt state file is not a crash', () => {
  fs.writeFileSync(STATE, 'not json at all');
  assert.equal(cooldown.activeHold('linkedin'), null);
  assert.doesNotThrow(() => cooldown.recordThrottle('linkedin', 'paused'));
});
