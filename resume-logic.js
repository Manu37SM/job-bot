const fs = require('fs');
const config = require('./config');
const policy = require('./question-policy');

function buildProfile(data) {
  const skills = data.skills || [];
  const certifications = data.certifications || [];
  const education = data.education || {};
  const employers = data.employers || [];
  const summary = data.summary || '';

  let resumeText = '';
  function loadResumeText() {
    if (resumeText) return resumeText;
    try {
      const txtPath = config.resumePath.replace(/\.pdf$/i, '.txt');
      if (fs.existsSync(txtPath)) {
        resumeText = fs.readFileSync(txtPath, 'utf-8');
      }
    } catch (e) {}
    return resumeText;
  }

  function mentionsSkill(text) {
    const needle = String(text || '')
      .trim()
      .toLowerCase();
    if (!needle) return false;
    if (skills.some((s) => s.toLowerCase() === needle)) return true;

    const haystacks = [...skills.map((s) => s.toLowerCase()), loadResumeText().toLowerCase()];
    return haystacks.some((h) => h.includes(needle));
  }

  const DEGREE_LEVELS = [
    { level: 4, pattern: /\b(ph\.?d|doctorate|doctoral)\b/i },
    {
      level: 3,
      pattern: /\b(master'?s?|m\.?tech|m\.?sc|m\.?s\.?|mba|m\.?c\.?a|post[- ]?grad\w*)\b/i,
    },
    {
      level: 2,
      pattern:
        /\b(bachelor'?s?|b\.?tech|b\.?e\b|b\.?sc|b\.?c\.?a|undergrad\w*|graduate degree|4[- ]year degree)\b/i,
    },
    { level: 1, pattern: /\b(diploma|associate'?s? degree|polytechnic)\b/i },
    { level: 0, pattern: /\b(high school|higher secondary|12th|hsc|secondary school)\b/i },
  ];

  const OWN_DEGREE_LEVEL = (() => {
    const declared = String(education.degreeLevel || '').toLowerCase();
    const found = DEGREE_LEVELS.find((entry) => entry.pattern.test(declared));
    return found ? found.level : 2;
  })();

  function askedDegreeLevel(question) {
    const hits = DEGREE_LEVELS.filter((entry) => entry.pattern.test(String(question || '')));
    return hits.length ? Math.max(...hits.map((h) => h.level)) : null;
  }

  const CERT_STOPWORDS = new Set(
    (
      'do you have has any all relevant the this that a an of for in with to and or are is hold holding ' +
      'currently valid active please select role position job listed below following required requirement ' +
      'requirements certification certifications certificate certificates certified certification(s) ' +
      'credential credentials license licence licensed licences qualifications qualification your own ' +
      'possess obtained completed which what does'
    ).split(/\s+/)
  );

  function namesSpecificCredential(question) {
    const haystack = [
      ...certifications.map((c) => c.toLowerCase()),
      ...skills.map((s) => s.toLowerCase()),
      loadResumeText().toLowerCase(),
    ].join(' ');

    const tokens = String(question || '')
      .toLowerCase()
      .split(/[^a-z0-9+#.-]+/)
      .filter((t) => t.length >= 2 && !CERT_STOPWORDS.has(t));

    return tokens.some((token) => !haystack.includes(token));
  }

  function isQuantityQuestion(text) {
    return /how many|how long|number of years|years? of|months? of|\byears?\b|\bmonths?\b/i.test(
      String(text || '')
    );
  }

  const MONTHS = {
    jan: 0,
    feb: 1,
    mar: 2,
    apr: 3,
    may: 4,
    jun: 5,
    jul: 6,
    aug: 7,
    sep: 8,
    oct: 9,
    nov: 10,
    dec: 11,
  };

  function parsePeriodDate(text, { endOfRange = false } = {}) {
    const value = String(text || '')
      .slice(0, 200)
      .trim();
    if (/^(present|current|now|till date|to date)$/i.test(value)) return new Date();
    const match = /([A-Za-z]{3,})\s+(\d{4})/.exec(value) || /(\d{4})/.exec(value);
    if (!match) return null;
    if (match.length === 2) return new Date(Number(match[1]), endOfRange ? 11 : 0, 1);
    const month = MONTHS[match[1].slice(0, 3).toLowerCase()];
    if (month == null) return null;
    return new Date(Number(match[2]), month, 1);
  }

  function tenureYears(employer) {
    const period = String(employer?.period || '');
    const [from, to] = period.split(/[–—-]|\bto\b/i).map((part) => part && part.trim());
    const start = parsePeriodDate(from);
    const end = parsePeriodDate(to, { endOfRange: true }) || new Date();
    if (!start || !end || end < start) return null;
    return Math.round(((end - start) / (365.25 * 24 * 3600 * 1000)) * 10) / 10;
  }

  function extractSkillFromQuestion(question) {
    const q = String(question || '');
    for (const skill of skills) {
      const re = new RegExp(`\\b${skill.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (re.test(q)) return skill;
    }
    return null;
  }

  function findOption(options, pattern) {
    return options.find((o) => pattern.test(o)) || '';
  }

  function answerFromResume(question, inputType = 'text', options = []) {
    const q = String(question || '').toLowerCase();
    const yes = () => findOption(options, /\byes\b/i) || 'Yes';
    const no = () => findOption(options, /\bno\b/i) || 'No';

    if (/degree|bachelor|master|phd|doctorate|graduate|qualification|diploma|mba/.test(q)) {
      if (
        /do you have|have you completed|are you a graduate|do you hold|possess/.test(q) ||
        options.length
      ) {
        const asked = askedDegreeLevel(question);
        if (asked == null) return yes();
        return OWN_DEGREE_LEVEL >= asked ? yes() : no();
      }
      return education.degree;
    }
    if (/university|college|institution/.test(q)) return education.institution;
    if (/gpa|percentage|cgpa/.test(q) && /education|academic|college|degree/.test(q)) {
      return String(education.gpaPercent);
    }

    const askedCert = certifications.find((c) => q.includes(c.toLowerCase()));
    if (askedCert) return options.length ? yes() : 'Yes';
    if (
      /certif\w*|credential|licen[cs]e|accredit/.test(q) &&
      policy.classify(question) === 'capability'
    ) {
      if (namesSpecificCredential(question)) return no();
      return certifications.length ? yes() : no();
    }

    if (policy.isTenureQuestion(question)) {
      const years = tenureYears(employers[0]);
      if (years == null) return '';
      return /months?/.test(q) ? String(Math.round(years * 12)) : String(years);
    }

    const skillFromQuestion = extractSkillFromQuestion(question);
    if (skillFromQuestion) {
      const quantity = isQuantityQuestion(question);
      if (options.length && !quantity) return mentionsSkill(skillFromQuestion) ? yes() : no();
      if (
        !quantity &&
        /do you|have you|are you|experience|familiar|proficient|skilled|knowledge of/.test(q)
      ) {
        return mentionsSkill(skillFromQuestion) ? 'Yes' : 'No';
      }
      if (quantity) {
        const fallback = config.skillExperienceFallbackYears;
        if (Number.isFinite(Number(fallback))) {
          const years = Math.min(
            Number(fallback),
            Number(config.experienceYears) || Number(fallback)
          );
          return /months?/.test(q) ? String(Math.round(years * 12)) : String(years);
        }
        return '';
      }
    }

    if (policy.classify(question) === 'capability') {
      const subject = policy.extractSubject(question);
      if (subject && policy.looksLikeTechnology(subject)) {
        const known = mentionsSkill(subject);
        if (options.length) return known ? yes() : no();
        if (!/how many|how long|years|months/.test(q)) return known ? 'Yes' : 'No';
      }
    }

    if (/how many years|years of experience|months of experience|years? of work/.test(q)) {
      const subject = policy.extractSubject(question);
      if (subject && policy.looksLikeTechnology(subject) && !mentionsSkill(subject)) {
        return /months?/.test(q) ? '0' : '0';
      }
    }

    if (/current company|current employer|where do you (currently )?work/.test(q)) {
      return employers[0]?.company || '';
    }
    if (/previous company|previous employer|last company/.test(q)) {
      return employers[1]?.company || '';
    }

    if (
      inputType === 'textarea' ||
      /tell us about yourself|professional summary|about you\b/.test(q)
    ) {
      return summary;
    }

    return '';
  }

  return {
    skills,
    certifications,
    education,
    employers,
    summary,
    loadResumeText,
    mentionsSkill,
    extractSkillFromQuestion,
    answerFromResume,
    tenureYears,
    isQuantityQuestion,
  };
}

module.exports = { buildProfile };
