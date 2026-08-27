// Cooperative shutdown. Ctrl+C used to kill the process outright, which skipped
// browser.close() (leaking a Chromium window), skipped the run summary, and
// skipped writing needs-review.md — so an interrupted run left nothing behind.
// Instead the signal sets a flag the job loop checks between jobs, and the normal
// finally/summary path runs exactly as it would at the end of a full run.
let stopRequested = false;
let reason = '';

function requestStop(why = 'interrupted') {
  stopRequested = true;
  reason = why;
}

function isStopRequested() {
  return stopRequested;
}

function stopReason() {
  return reason;
}

// A second Ctrl+C means "I meant it" — bail out immediately rather than waiting
// for the current application to finish.
function installSignalHandlers() {
  let hits = 0;
  const onSignal = () => {
    hits++;
    if (hits === 1) {
      console.log('\n\n🛑 Stopping after the current job. Press Ctrl+C again to quit immediately.');
      requestStop('interrupted by user');
      return;
    }
    console.log('\n⚠️  Forced exit — the browser window may need closing manually.');
    process.exit(130);
  };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
}

module.exports = { requestStop, isStopRequested, stopReason, installSignalHandlers };
