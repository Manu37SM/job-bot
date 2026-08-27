const fs = require('fs');
const path = require('path');
const { cleanText, cleanCompany } = require('./text-utils');
const {
  extractSubject: extractSkill,
  looksLikeTechnology,
  classify,
} = require('./question-policy');
const {
  openFailures,
  describeCode,
  isTransient,
  normalizeQuestion,
  MAX_FAILED_ATTEMPTS,
  RETIRE_COOLDOWN_DAYS,
  daysSinceLastAttempt,
} = require('./logger');

const REPORT_FILE = path.join(__dirname, 'needs-review.md');

function groupUnanswered(failures) {
  const groups = new Map();
  for (const failure of failures) {
    for (const item of failure.unanswered || []) {
      const key = normalizeQuestion(item.question);
      if (!key) continue;
      if (!groups.has(key)) {
        groups.set(key, {
          question: item.question,
          kind: item.kind,
          options: item.options || [],
          jobs: [],
        });
      }
      const group = groups.get(key);
      if (!group.options.length && item.options?.length) group.options = item.options;
      group.jobs.push(failure);
    }
  }
  return [...groups.values()].sort((a, b) => b.jobs.length - a.jobs.length);
}

function groupBlockers(failures) {
  const groups = new Map();
  for (const failure of failures) {
    for (const blocker of failure.blockers || []) {
      const key = normalizeQuestion(blocker);
      if (!key) continue;
      if (!groups.has(key)) groups.set(key, { blocker, jobs: [] });
      groups.get(key).jobs.push(failure);
    }
  }
  return [...groups.values()].sort((a, b) => b.jobs.length - a.jobs.length);
}

// The stored link is whatever the results page URL happened to be, which opens
// the search rather than the posting. When the jobId is known, the canonical
// permalink is far more useful in a report you are meant to click through.
function jobUrl(failure) {
  const id = String(failure.jobId || '').trim();
  if (/^\d+$/.test(id)) return `https://www.linkedin.com/jobs/view/${id}`;
  return failure.link || '';
}

function jobLine(failure) {
  // Entries logged before the scraper tidied its output still carry raw innerText,
  // padding and all. Tidy at render time so the report reads the same either way.
  const title = cleanText(failure.title) || 'Unknown role';
  const company = cleanCompany(failure.company) || 'Unknown company';
  const where = `${title} @ ${company}`;
  const url = jobUrl(failure);
  return url ? `[${where}](${url})` : where;
}

// A ready-to-paste config.customAnswers entry for one question. This is the
// escape hatch for everything the bot deliberately refuses to guess at, so the
// report should hand it over rather than describe it.
function customAnswerSnippet(group) {
  const question = String(group.question || '')
    .replace(/\s+/g, ' ')
    .trim();
  // Match on a distinctive slice rather than the whole sentence: the same question
  // is worded slightly differently by different companies.
  const keywords = question
    .toLowerCase()
    .replace(/[^a-z0-9\s+#.-]/g, ' ')
    .split(/\s+/)
    .filter(
      (w) =>
        w.length > 3 &&
        !/^(what|when|where|which|your|have|does|will|with|this|that|from|about|many|much|would|there|their)$/.test(
          w
        )
    )
    .slice(0, 4)
    .join('.*');
  // `answer` is deliberately left EMPTY. Pre-filling it with the form's first
  // option would put a specific claim in the candidate's mouth — "Male", "Yes, I
  // work night shifts" — which is precisely what this whole layer exists to stop.
  // The options are listed alongside so the choice is easy but still theirs.
  const choices = (group.options || []).length
    ? `  // options: ${group.options.slice(0, 10).join(' | ')}`
    : '';
  const pattern = keywords || question.slice(0, 30).toLowerCase();
  return `${choices ? choices + '\n  ' : ''}{ match: /${pattern}/i, answer: '' },`;
}

function suggestFix(group) {
  const q = normalizeQuestion(group.question);

  // Classified questions come first, and by asking question-policy.js rather than
  // re-deriving the categories here. Duplicating those regexes is how "What is your
  // date of birth?" ended up with generic advice while "What is your gender?" got
  // the right answer — the copy had drifted from the original.
  const kind = classify(group.question);
  if (kind === 'eeo') {
    return 'Protected-characteristic question — the bot will not answer it for you. Add a `customAnswers` entry if you want it filled.';
  }
  if (kind === 'work_authorization' || kind === 'sponsorship') {
    return 'Check `authorization.authorizedCountries` in config.js.';
  }
  if (kind === 'relocation') {
    return 'Check `locations` in config.js, or set `willingToRelocate` to a fixed answer.';
  }
  if (kind === 'shift') return 'Check `dayShiftOnly` in config.js.';
  if (kind === 'legal_history') return 'Add a `customAnswers` entry (see below).';

  if (/\byears?\b/.test(q) && /experien/.test(q)) {
    const skill = extractSkill(group.question);
    return skill && looksLikeTechnology(skill)
      ? `Add \`'${skill}': <years>\` to \`skillExperienceYears\` in config.js.`
      : 'Add a `customAnswers` entry with the number (see below).';
  }
  if (/salary|ctc|compensation|\brate\b/.test(q)) return 'Check `currentCTC` / `expectedCTC` in config.js.';
  if (/notice|join|start date|available/.test(q)) return 'Check `noticePeriod` / `lastWorkingDay` in config.js.';
  if (/certif|licen[cs]e|credential|accredit/.test(q)) return 'Add it to `certifications` in resume-profile.js.';
  if (/degree|bachelor|master|graduat|educat|university|college/.test(q)) {
    return 'Add it to `education` in resume-profile.js.';
  }
  if (/location|city|commute/.test(q)) return 'Check `locations` in config.js.';

  if (/experience|familiar|proficien|knowledge of|worked with/.test(q)) {
    // Only point at the skills list when the question is actually about a
    // technology. "Experience in fast-paced environments" is not something to add
    // to `skills`, and saying so sends the reader on a pointless errand.
    const subject = extractSkill(group.question);
    return subject && looksLikeTechnology(subject)
      ? 'Add the technology to `skills` in resume-profile.js.'
      : 'Not a technology — add a `customAnswers` entry (see below).';
  }

  return 'Add a `customAnswers` entry (see below).';
}

function buildReport(failures) {
  const now = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const retired = failures.filter((f) => (f.totalFailures || 1) >= MAX_FAILED_ATTEMPTS);
  const parked = failures.filter((f) => !isTransient(f.code));
  const retryable = failures.filter(
    (f) => isTransient(f.code) && (f.totalFailures || 1) < MAX_FAILED_ATTEMPTS
  );

  const lines = [];
  lines.push('# Applications that need you');
  lines.push('');
  lines.push(`_Generated ${now} — regenerated on every run._`);
  lines.push('');
  lines.push(
    `**${failures.length}** job${failures.length === 1 ? '' : 's'} did not go through: ` +
      `**${parked.length}** waiting on an answer from you, ` +
      `**${retryable.length}** will be retried automatically, ` +
      `**${retired.length}** set aside after ${MAX_FAILED_ATTEMPTS} attempts ` +
      `(each gets another chance after ${RETIRE_COOLDOWN_DAYS} days).`
  );
  lines.push('');

  const questionGroups = groupUnanswered(failures);
  if (questionGroups.length) {
    lines.push('## Fix these first');
    lines.push('');
    lines.push(
      'Each row is one question the bot could not answer, ranked by how many applications it cost you.'
    );
    lines.push('Answering the top one or two usually unblocks the whole list on the next run.');
    lines.push('');
    lines.push('| Jobs blocked | Question | Field | Where to fix it |');
    lines.push('| ---: | --- | --- | --- |');
    for (const group of questionGroups.slice(0, 40)) {
      const question = group.question.replace(/\|/g, '\\|').replace(/\n+/g, ' ').slice(0, 160);
      lines.push(
        `| ${group.jobs.length} | ${question} | ${group.kind || '—'} | ${suggestFix(group)} |`
      );
    }
    lines.push('');

    lines.push('### Paste-ready answers');
    lines.push('');
    lines.push(
      'Drop the entries you want into `customAnswers` in `config.js`, filling in each `answer`.'
    );
    lines.push('They are checked before every other rule, so they always win.');
    lines.push('');
    lines.push('```js');
    lines.push('customAnswers: [');
    for (const group of questionGroups.slice(0, 15)) {
      lines.push(`  // ${group.question.replace(/\s+/g, ' ').slice(0, 100)}`);
      lines.push(`  ${customAnswerSnippet(group)}`);
    }
    lines.push('],');
    lines.push('```');
    lines.push('');

    const withOptions = questionGroups.filter((g) => g.options?.length);
    if (withOptions.length) {
      lines.push('<details><summary>Answer options the form offered</summary>');
      lines.push('');
      for (const group of withOptions.slice(0, 20)) {
        lines.push(`- **${group.question.replace(/\n+/g, ' ').slice(0, 140)}**`);
        lines.push(
          `  - options: ${group.options
            .slice(0, 12)
            .map((o) => `\`${o}\``)
            .join(', ')}`
        );
      }
      lines.push('');
      lines.push('</details>');
      lines.push('');
    }
  }

  const blockerGroups = groupBlockers(failures);
  if (blockerGroups.length) {
    lines.push('## Values the form rejected');
    lines.push('');
    lines.push(
      'The bot had an answer here, but LinkedIn refused it — usually a format problem (a decimal in an integer-only box, a city that must be picked from the dropdown).'
    );
    lines.push('');
    lines.push('| Jobs blocked | Field and error |');
    lines.push('| ---: | --- |');
    for (const group of blockerGroups.slice(0, 30)) {
      lines.push(`| ${group.jobs.length} | ${group.blocker.replace(/\|/g, '\\|').slice(0, 200)} |`);
    }
    lines.push('');
  }

  // Grouped by cause rather than one flat list. A hundred lines of "Every open
  // job" is not something anyone reads; "26 timed out, 4 need an answer" is.
  const byCode = new Map();
  for (const failure of failures) {
    const key = failure.code || '';
    if (!byCode.has(key)) byCode.set(key, []);
    byCode.get(key).push(failure);
  }

  const groups = [...byCode.entries()].sort((a, b) => {
    // Things the candidate can act on come first.
    const actionable = (code) => (isTransient(code) ? 1 : 0);
    if (actionable(a[0]) !== actionable(b[0])) return actionable(a[0]) - actionable(b[0]);
    return b[1].length - a[1].length;
  });

  lines.push('## Open jobs by cause');
  lines.push('');

  for (const [code, jobs] of groups) {
    const note = isTransient(code) ? 'retried automatically' : 'waiting on your answers';
    lines.push(`### ${describeCode(code)} — ${jobs.length} (${note})`);
    lines.push('');

    const sorted = [...jobs].sort((a, b) => String(b.appliedAt).localeCompare(String(a.appliedAt)));
    for (const failure of sorted) {
      const attempts = failure.totalFailures || 1;
      const days = daysSinceLastAttempt(failure);
      const cooledDown = days != null && days >= RETIRE_COOLDOWN_DAYS;
      const state =
        attempts >= MAX_FAILED_ATTEMPTS
          ? cooledDown
            ? 'set aside, cooldown passed — retried next run'
            : `set aside (retried after ${RETIRE_COOLDOWN_DAYS} days)`
          : isTransient(failure.code)
            ? 'auto-retry next run'
            : 'waiting on your answers';
      const when = String(failure.appliedAt).slice(0, 16).replace('T', ' ');
      lines.push(`- ${jobLine(failure)}`);
      // The code is already the heading, so only a reason that adds something is
      // worth repeating under every single row.
      if (failure.reason && failure.reason !== describeCode(failure.code)) {
        lines.push(`  - ${failure.reason}`);
      }
      lines.push(`  - attempt ${attempts}/${MAX_FAILED_ATTEMPTS} · ${state} · last tried ${when}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function writeReviewReport() {
  const failures = openFailures();

  if (failures.length === 0) {
    // Best-effort: a locked or read-only file must not take the whole run down
    // at the very last step, after every application has already been made.
    try {
      if (fs.existsSync(REPORT_FILE)) fs.unlinkSync(REPORT_FILE);
    } catch {
      fs.writeFileSync(
        REPORT_FILE,
        '# Applications that need you\n\nNothing open — every application went through.\n'
      );
    }
    console.log('🎉 Nothing needs review — no open failures.');
    return null;
  }

  fs.writeFileSync(REPORT_FILE, buildReport(failures));
  const parked = failures.filter((f) => !isTransient(f.code)).length;
  console.log(
    `📝 Review report → needs-review.md (${failures.length} open, ${parked} waiting on you)`
  );
  return REPORT_FILE;
}

const DRY_RUN_FILE = path.join(__dirname, 'dry-run.md');

// A dry run's whole point is to answer "are these the right jobs?" before any
// application is spent. A count on the terminal cannot answer that; a list can.
function buildDryRunReport({ jobs = [], screened = [] }) {
  const lines = ['# Dry run', ''];
  lines.push(`**${jobs.length}** jobs would have been applied to; **${screened.length}** were screened out.`);
  lines.push('');
  lines.push('Nothing was applied to and nothing was written to `applications.json`.');
  lines.push('');

  if (jobs.length) {
    lines.push('## Would have applied');
    lines.push('');
    for (const job of jobs) {
      const where = `${cleanText(job.title) || 'Unknown role'} @ ${cleanCompany(job.company) || 'Unknown company'}`;
      lines.push(job.link ? `- [${where}](${job.link})` : `- ${where}`);
    }
    lines.push('');
  }

  if (screened.length) {
    // Grouped by reason, and ordered so the ones worth acting on come first.
    // "Already applied" is usually most of the list and is not a decision to
    // review — collapsing it keeps the rows that ARE decisions visible.
    const byReason = new Map();
    for (const job of screened) {
      const reason = job.reason || 'skipped';
      if (!byReason.has(reason)) byReason.set(reason, []);
      byReason.get(reason).push(job);
    }

    // A reason the candidate might want to change, versus bookkeeping.
    const actionable = (reason) => !/already applied|per-company cap/i.test(reason);

    const groups = [...byReason.entries()].sort((a, b) => {
      if (actionable(a[0]) !== actionable(b[0])) return actionable(a[0]) ? -1 : 1;
      return b[1].length - a[1].length;
    });

    lines.push('## Screened out');
    lines.push('');
    lines.push('If something here looks like a job you wanted, change the rule named beside it.');
    lines.push('');

    for (const [reason, group] of groups) {
      lines.push(`### ${reason} — ${group.length}`);
      lines.push('');
      if (!actionable(reason)) {
        // Bookkeeping: the count is the whole message.
        lines.push(`_${group.length} job${group.length === 1 ? '' : 's'}, listed for completeness._`);
        lines.push('');
        lines.push('<details><summary>Show them</summary>');
        lines.push('');
      }
      for (const job of group) {
        const where = `${cleanText(job.title) || 'Unknown role'} @ ${cleanCompany(job.company) || 'Unknown company'}`;
        lines.push(job.link ? `- [${where}](${job.link})` : `- ${where}`);
      }
      lines.push('');
      if (!actionable(reason)) {
        lines.push('</details>');
        lines.push('');
      }
    }
  }

  if (!jobs.length && !screened.length) {
    lines.push('No jobs were reached at all. See the warning printed above the summary.');
    lines.push('');
  }

  return lines.join('\n');
}

function writeDryRunReport(tally) {
  try {
    fs.writeFileSync(DRY_RUN_FILE, buildDryRunReport(tally || {}));
    return DRY_RUN_FILE;
  } catch {
    return null;
  }
}

module.exports = {
  writeReviewReport,
  writeDryRunReport,
  buildDryRunReport,
  buildReport,
  groupUnanswered,
  groupBlockers,
  normalizeQuestion,
  extractSkill,
  customAnswerSnippet,
  jobUrl,
  suggestFix,
};
