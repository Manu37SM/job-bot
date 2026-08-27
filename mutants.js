#!/usr/bin/env node
// Mutation testing: deliberately break the code and check the tests notice.
//
// A passing suite proves the tests run, not that they would catch a regression.
// Each mutant below is a real bug this project has had, or a rule it depends on.
// A mutant that SURVIVES — tests still green — is a gap: that behaviour is not
// actually pinned down anywhere, and the next person to touch it gets no warning.
//
// Mutations are applied to a COPY of the project in a temp directory. The real
// files are never written to, so an interrupted run cannot leave the repo broken.
//
//   node mutants.js                  run every mutant (slow — a test run each)
//   node mutants.js policy           run only mutants whose name matches
//   node mutants.js --anchors        just check every mutant still applies (fast)
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = __dirname;

const MUTANTS = [
  // --- answer integrity ---------------------------------------------------
  ['policy: EEO not classified', 'question-policy.js', "  if (EEO.test(q)) return 'eeo';", "  if (false && EEO.test(q)) return 'eeo';"],
  ['policy: everything guessable', 'question-policy.js', "  return kind === 'consent' || kind === 'generic';", '  return true;'],
  ['policy: authorization always yes', 'question-policy.js', "  if (status === 'no') return noOption(options);", "  if (status === 'no') return yesOption(options);"],
  ['policy: eeo picks first option', 'question-policy.js', "  return findOption(options, DECLINE) || '';", "  return (options || [])[0] || '';"],
  ['policy: tenure never detected', 'question-policy.js', "  return TENURE.test(String(question || ''));", '  return false;'],
  ['logic: any degree answers yes', 'resume-logic.js', '      return OWN_DEGREE_LEVEL >= asked ? yes() : no();', '      return yes();'],
  ['logic: quantity guard removed', 'resume-logic.js', '  function isQuantityQuestion(text) {', '  function isQuantityQuestion(text) {\n    return false;'],
  ['logic: credentials always claimed', 'resume-logic.js', '      if (namesSpecificCredential(question)) return no();', '      // mutant'],
  ['logic: tenure uses total experience', 'answer-utils.js', "  if (policy.isTenureQuestion(question)) return '';", '  // mutant'],

  // --- numeric handling ---------------------------------------------------
  ['numeric: worded quantities ignored', 'answer-utils.js', '  if (word && nums.length === 0) return { lo: word.value, hi: word.value };', '  // mutant'],
  ['numeric: open ranges collapse', 'answer-utils.js', '  if (/\\+/.test(text) || OPEN_UPPER.test(text)) return { lo: nums[0], hi: Infinity };', '  // mutant'],
  ['field-value: self-claims round up', 'field-value.js', '    if (isSelfClaim) values.push(Math.floor(value), Math.round(value), Math.ceil(value));', '    if (false) values.push(Math.floor(value), Math.round(value), Math.ceil(value));'],

  // --- form filling -------------------------------------------------------
  ['form: refuses nothing', 'linkedin.js', '          if (!policy.mayGuess(questionLabel)) {\n            console.warn(`  No matching option for', '          if (false) {\n            console.warn(`  No matching option for'],
  ['form: checkbox ticks at random', 'linkedin.js', '          if (isRequired && !policy.mayGuess(questionLabel)) {', '          if (false) {'],
  ['form: unanswered not recorded', 'linkedin.js', '    unanswered.push({', '    if (false) unanswered.push({'],
  ['form: answers not recorded', 'linkedin.js', '    answered.push({ kind, question: text.slice(0, 200), answer: value.slice(0, 200) });', '    // mutant'],
  ['form: stall hides the real cause', 'linkedin.js', '    unanswered.length\n      ? fail(', '    false\n      ? fail('],
  ['form: submit never confirmed', 'linkedin.js', '  if (successText) return true;', '  return true;\n  if (successText) return true;'],
  ['form: modal close not verified', 'linkedin.js', "  const stillOpen = await modalPresent(page);", '  return true;\n  const stillOpen = await modalPresent(page);'],

  // --- guardrails ---------------------------------------------------------
  ['logger: every failure retryable', 'logger.js', '  return FAILURE_CODES[code]?.transient !== false;', '  return true;'],
  ['logger: backoff disabled', 'logger.js', '  const failures = failuresFor(id);\n  if (failures.length === 0) return null;', '  const failures = failuresFor(id);\n  return null;'],
  ['logger: skip rows do not collapse', 'logger.js', "  if (status === 'skipped') {\n    const existing = log.find(", "  if (false && status === 'skipped') {\n    const existing = log.find("],
  ['cooldown: hold never active', 'cooldown.js', '  if (!Number.isFinite(until) || until <= now) return null;', '  return null;'],
  ['cooldown: hold never expires', 'cooldown.js', '  if (!Number.isFinite(until) || until <= now) return null;', '  if (!Number.isFinite(until)) return null;'],
  ['cli: --limit can raise the cap', 'linkedin.js', '  const capped = Math.min(perRun, requested);', '  const capped = requested;'],
  ['cli: malformed --limit becomes 0', 'cli.js', '  return raw != null && Number.isFinite(parsed) ? parsed : fallback;', '  return parsed || fallback;'],
  ['shutdown: stop request ignored', 'shutdown.js', '  return stopRequested;', '  return false;'],

  // --- screening and reporting --------------------------------------------
  ['title: never screens a role out', 'title-fit.js', "  if (!enabled || !text) return { skip: false };", '  return { skip: false };'],
  ['title: stack check ignores the CV', 'title-fit.js', '    if (profile.mentionsSkill(marker)) continue;', '    // mutant'],
  ['title: word boundaries removed', 'title-fit.js', '  return isBoundary(before) && isBoundary(after);', '  return true;'],
  ['fit: never screens anything out', 'job-fit.js', '  if (required <= have + tolerance) return { skip: false };', '  return { skip: false };'],
  ['fit: any number is experience', 'job-fit.js', '      if (!nearExperience(text, match.index)) continue;', '      // mutant'],
  ['search: entry level for everyone', 'search-filters.js', "  if (value < 7) return ['associate', 'mid-senior'];", "  if (value < 7) return ['entry', 'associate', 'mid-senior'];"],
  ['search: date filter dropped', 'search-filters.js', '  return `r${Math.round(value * 86400)}`;', "  return '';"],
  ['report: answer pre-filled again', 'failure-report.js', "  return `${choices ? choices + '\\n  ' : ''}{ match: /${pattern}/i, answer: '' },`;", "  return `{ match: /${pattern}/i, answer: '${(group.options || [])[0] || ''}' },`;"],
  ['report: questions not deduplicated', 'failure-report.js', '      const key = normalizeQuestion(item.question);\n      if (!key) continue;', '      const key = item.question;\n      if (!key) continue;'],
  ['preflight: missing resume ignored', 'preflight.js', '      level: \'error\',\n      message: `Resume not found', '      level: \'warn\',\n      message: `Resume not found'],
  ['preflight: bad customAnswers ok', 'preflight.js', '      if (!okMatch) {', '      if (false) {'],
  ['text: company metadata kept', 'text-utils.js', "      .split('\\n')[0]", "      .split('ZZZ')[0]"],
];

function prepareSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'job-bot-mutation-'));
  fs.mkdirSync(path.join(dir, 'test', 'helpers'), { recursive: true });

  for (const entry of fs.readdirSync(ROOT)) {
    if (entry.endsWith('.js') || ['package.json', '.prettierrc', 'README.md'].includes(entry)) {
      fs.copyFileSync(path.join(ROOT, entry), path.join(dir, entry));
    }
    // The suite reads the CV text and checks the session file exists.
    if (/\.(txt|pdf)$/i.test(entry) || entry === 'session-linkedin.json') {
      fs.copyFileSync(path.join(ROOT, entry), path.join(dir, entry));
    }
  }
  for (const entry of fs.readdirSync(path.join(ROOT, 'test'))) {
    if (entry.endsWith('.js')) fs.copyFileSync(path.join(ROOT, 'test', entry), path.join(dir, 'test', entry));
  }
  for (const entry of fs.readdirSync(path.join(ROOT, 'test', 'helpers'))) {
    fs.copyFileSync(path.join(ROOT, 'test', 'helpers', entry), path.join(dir, 'test', 'helpers', entry));
  }
  fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
  return dir;
}

function testsPass(dir) {
  try {
    const out = execFileSync('npm', ['test'], { cwd: dir, encoding: 'utf-8', stdio: 'pipe', timeout: 300000 });
    return out.includes('# fail 0');
  } catch (err) {
    return String(err.stdout || '').includes('# fail 0');
  }
}

// A mutant whose anchor text no longer exists proves nothing — it silently stops
// testing whatever it was there to test. Checking that separately is instant,
// where a full run is a test suite per mutant.
function checkAnchors() {
  const stale = [];
  for (const [name, file, from] of MUTANTS) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf-8');
    const occurrences = src.split(from).length - 1;
    if (occurrences !== 1) stale.push(`${name} (${file}): found ${occurrences}, expected 1`);
  }
  if (stale.length) {
    console.error(`${stale.length} stale mutant anchor(s):`);
    for (const line of stale) console.error(`  - ${line}`);
    process.exitCode = 1;
  } else {
    console.log(`All ${MUTANTS.length} mutant anchors still apply.`);
  }
}

function main() {
  const filter = process.argv[2];
  if (filter === '--anchors') return checkAnchors();

  const selected = filter ? MUTANTS.filter(([name]) => name.includes(filter)) : MUTANTS;

  const dir = prepareSandbox();
  console.log(`Sandbox: ${dir}`);

  if (!testsPass(dir)) {
    console.error('The sandbox baseline is already failing — fix the suite first.');
    process.exitCode = 1;
    return;
  }
  console.log(`Baseline green. Running ${selected.length} mutants (a test run each)...\n`);

  const survived = [];
  const missing = [];

  for (const [name, file, from, to] of selected) {
    const target = path.join(dir, file);
    const original = fs.readFileSync(target, 'utf-8');
    const occurrences = original.split(from).length - 1;

    if (occurrences !== 1) {
      // The anchor moved — the mutant is stale and proves nothing either way.
      missing.push(name);
      console.log(`  ${name.padEnd(38)} ANCHOR MISSING (${occurrences})`);
      continue;
    }

    fs.writeFileSync(target, original.replace(from, to));
    let killed;
    try {
      killed = !testsPass(dir);
    } finally {
      fs.writeFileSync(target, original);
    }

    if (!killed) survived.push(name);
    console.log(`  ${name.padEnd(38)} ${killed ? 'killed' : 'SURVIVED'}`);
  }

  const scored = selected.length - missing.length;
  console.log(`\n${scored - survived.length}/${scored} killed`);
  if (missing.length) console.log(`${missing.length} stale anchor(s) — update mutation-test.js`);
  if (survived.length) {
    console.log('\nSurvivors are gaps. Nothing tests this behaviour:');
    for (const name of survived) console.log(`  - ${name}`);
    process.exitCode = 1;
  }
}

if (require.main === module) main();
module.exports = { MUTANTS, checkAnchors };
