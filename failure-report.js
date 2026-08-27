const fs = require('fs');
const path = require('path');
const {
  openFailures,
  describeCode,
  isTransient,
  normalizeQuestion,
  MAX_FAILED_ATTEMPTS,
} = require('./logger');

const REPORT_FILE = path.join(__dirname, 'needs-review.md');

// Pull the technology out of a skill question. The LAST "with"/"in"/"using" is
// the right one: "How many years of experience do you have with Kubernetes?"
// has an earlier "of" that would otherwise swallow the whole sentence.
function extractSkill(question) {
  const matches = [
    ...String(question || '').matchAll(
      /\b(?:with|in|using)\s+([A-Za-z][\w+#.\-]*(?:\s+[A-Za-z][\w+#.\-]*){0,2})/gi
    ),
  ];
  if (!matches.length) return '';
  const candidate = matches[matches.length - 1][1]
    .replace(/\b(?:a|an|the|your|this|role|position|job|years?|experience)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return candidate.length >= 2 && candidate.length <= 30 ? candidate : '';
}

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
  const where = `${failure.title || 'Unknown role'} @ ${failure.company || 'Unknown company'}`;
  const url = jobUrl(failure);
  return url ? `[${where}](${url})` : where;
}

function suggestFix(group) {
  const q = normalizeQuestion(group.question);
  if (/\byears?\b/.test(q) && /experien/.test(q)) {
    const skill = extractSkill(group.question);
    return skill
      ? `Add \`'${skill}': <years>\` to \`skillExperienceYears\` in config.js.`
      : 'Add the technology to `skillExperienceYears` in config.js.';
  }
  if (/salary|ctc|compensation|rate/.test(q))
    return 'Check `currentCTC` / `expectedCTC` in config.js.';
  if (/notice|join|start date|available/.test(q))
    return 'Check `noticePeriod` / `lastWorkingDay` in config.js.';
  if (/certif|licen[cs]e/.test(q)) return 'Add it to `certifications` in resume-profile.js.';
  if (/degree|bachelor|master|graduat|educat|university|college/.test(q))
    return 'Add it to `education` in resume-profile.js.';
  if (/sponsor|visa|work authoriz|right to work/.test(q))
    return 'Check the authorization answers in config.js.';
  if (/location|relocat|city|commute/.test(q)) return 'Check `locations` in config.js.';
  if (/experience|familiar|proficien|knowledge of|worked with/.test(q))
    return 'Add the technology to `skills` in resume-profile.js.';
  return 'Add a matching fact to config.js or resume-profile.js.';
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
      `**${retired.length}** retired after ${MAX_FAILED_ATTEMPTS} attempts.`
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

  lines.push('## Every open job');
  lines.push('');
  const sorted = [...failures].sort((a, b) =>
    String(b.appliedAt).localeCompare(String(a.appliedAt))
  );
  for (const failure of sorted) {
    const attempts = failure.totalFailures || 1;
    const state =
      attempts >= MAX_FAILED_ATTEMPTS
        ? 'retired'
        : isTransient(failure.code)
          ? 'auto-retry next run'
          : 'waiting on your answers';
    lines.push(`- ${jobLine(failure)}`);
    const detail = failure.reason ? ` — ${failure.reason}` : '';
    lines.push(`  - ${describeCode(failure.code)}${detail}`);
    lines.push(
      `  - attempt ${attempts}/${MAX_FAILED_ATTEMPTS} · ${state} · last tried ${String(failure.appliedAt).slice(0, 16).replace('T', ' ')}`
    );
  }
  lines.push('');

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

module.exports = {
  writeReviewReport,
  buildReport,
  groupUnanswered,
  groupBlockers,
  normalizeQuestion,
  extractSkill,
  jobUrl,
  suggestFix,
};
