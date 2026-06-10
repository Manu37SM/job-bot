const { runLinkedIn } = require('./linkedin');
const { printSummary, totalAppliedCount } = require('./logger');
const { printLocationSummary } = require('./location-helper');
const { printSalarySummary } = require('./salary-helper');
const config = require('./config');

async function main() {
  console.log('LINKEDIN JOB APPLICATION BOT');
  console.log(`Applicant       : ${config.name}`);
  printSalarySummary();
  console.log(`Notice Period   : ${config.noticePeriod}`);
  console.log(`Last Working Day: ${config.lastWorkingDay}`);
  console.log(`Positions       : ${config.positions.join(', ')}`);
  console.log(`Job Type        : ${config.jobTypes.join(', ')}`);
  console.log(`Day Shift Only  : ${config.dayShiftOnly ? 'Yes' : 'No'}`);
  printLocationSummary();

  const applied = totalAppliedCount();
  const { lifetime, perRun } = config.applicationLimits;
  const remaining = Math.max(0, lifetime - applied);

  console.log(
    `Progress        : ${applied}/${lifetime} lifetime | ${remaining} remaining | ${perRun}/run`
  );
  console.log('The bot opens a real browser. Press Ctrl+C to stop.\n');

  if (applied >= lifetime) {
    console.log(`LinkedIn lifetime limit reached (${applied}/${lifetime}).`);
    printSummary();
    return;
  }

  await runLinkedIn().catch((err) => console.error('LinkedIn failed:', err.message));
  printSummary();
}

main();
