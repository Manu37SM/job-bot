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
