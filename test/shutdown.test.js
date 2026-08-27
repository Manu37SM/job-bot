const test = require('node:test');
const assert = require('node:assert/strict');

// Loaded fresh per assertion group: the module holds process-wide state by design.
function freshShutdown() {
  delete require.cache[require.resolve('../shutdown')];
  return require('../shutdown');
}

test('a run is not stopping until something asks it to', () => {
  const shutdown = freshShutdown();
  assert.equal(shutdown.isStopRequested(), false);
  assert.equal(shutdown.stopReason(), '');
});

test('requesting a stop is visible to the job loop', () => {
  // This is the whole Ctrl+C mechanism: the signal sets a flag, and the loop reads
  // it between jobs so the browser closes and the summary still prints. If the
  // read stops working, Ctrl+C silently does nothing.
  const shutdown = freshShutdown();
  shutdown.requestStop('interrupted by user');
  assert.equal(shutdown.isStopRequested(), true);
  assert.equal(shutdown.stopReason(), 'interrupted by user');
});

test('a stop request has a default reason', () => {
  const shutdown = freshShutdown();
  shutdown.requestStop();
  assert.equal(shutdown.isStopRequested(), true);
  assert.ok(shutdown.stopReason().length > 0);
});

test('a stop cannot be un-requested by a later call', () => {
  const shutdown = freshShutdown();
  shutdown.requestStop('first');
  shutdown.requestStop('second');
  assert.equal(shutdown.isStopRequested(), true, 'stopping is one-way within a run');
});

test('the failure budget uses the same stop mechanism', () => {
  // searchAndApply calls requestStop() when the failure budget is exhausted, so
  // this flag is not only about Ctrl+C.
  const shutdown = freshShutdown();
  shutdown.requestStop('failure budget exhausted');
  assert.match(shutdown.stopReason(), /failure budget/);
});

test('installSignalHandlers registers without throwing and can be removed', () => {
  const shutdown = freshShutdown();
  const before = process.listenerCount('SIGINT');
  shutdown.installSignalHandlers();
  assert.equal(process.listenerCount('SIGINT'), before + 1);
  assert.equal(process.listenerCount('SIGTERM') > 0, true);
  // Leave the process as we found it, or the test runner inherits our handlers.
  process.removeAllListeners('SIGINT');
  process.removeAllListeners('SIGTERM');
});
