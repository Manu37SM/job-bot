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

// Normalised company identity. LinkedIn renders the same employer half a dozen
// ways ("Acme Pvt Ltd", "Acme Private Limited", "Acme"), and a per-company cap that
// treats those as different companies is no cap at all.
function companyKey(company) {
  return String(company || '')
    .toLowerCase()
    .replace(
      /\b(pvt|private|ltd|limited|llp|inc|corp|corporation|technologies|technology|solutions|services|india)\b/g,
      ''
    )
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

module.exports = { cleanText, cleanCompany, companyKey };
