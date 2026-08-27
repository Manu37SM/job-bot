#!/usr/bin/env node
// One-off maintenance: collapse duplicate "skipped" rows in applications.json.
// Every run before the dedupe fix appended a fresh row for each job it skipped,
// so the file grew without bound and was re-parsed on every lookup.
const fs = require('fs');
const { compactLog, saveLog, loadLog, LOG_FILE } = require('./logger');

function main() {
const before = fs.existsSync(LOG_FILE) ? fs.statSync(LOG_FILE).size : 0;
const { log, before: rowsBefore, after: rowsAfter, collapsed } = compactLog();

if (collapsed === 0) {
  console.log('✅ Nothing to compact — no duplicate skip rows.');
  return;
}

const backup = `${LOG_FILE}.backup-${new Date().toISOString().slice(0, 10)}`;
fs.copyFileSync(LOG_FILE, backup);
saveLog(log);

const after = fs.statSync(LOG_FILE).size;
const applied = loadLog().filter((e) => e.status === 'applied').length;
const failed = loadLog().filter((e) => e.status === 'failed').length;

console.log(
  `✅ Compacted ${rowsBefore} → ${rowsAfter} rows (${collapsed} duplicate skips collapsed)`
);
console.log(`   ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB`);
console.log(`   Preserved: ${applied} applied, ${failed} failed`);
console.log(`   Backup: ${backup}`);
}

if (require.main === module) main();

module.exports = { main };
