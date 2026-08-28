function cleanText(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cleanCompany(text) {
  return cleanText(
    String(text || '')
      .split('\n')[0]
      .replace(/\s*·.*$/, '')
  );
}

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
