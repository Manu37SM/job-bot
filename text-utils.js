// Small text tidying shared by the scraper and the report. Lives on its own so the
// report can use it without pulling in Playwright through linkedin.js.

// A job title wraps across lines, so its newlines are layout and must become
// spaces — splitting on them turns "Backend\nEngineer" into "Backend".
function cleanText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

// A company name is the opposite: everything after the first line is metadata
// ("1,001-5,000 employees"), and everything after a "·" is the location.
function cleanCompany(text) {
  return cleanText(
    String(text || '')
      .split('\n')[0]
      .replace(/\s*·.*$/, '')
  );
}

module.exports = { cleanText, cleanCompany };
