// The answering logic for a CV profile, shared by resume-profile.js and its
// example template.
//
// This used to live inside resume-profile.js, and resume-profile.example.js
// carried its own copy. The copy drifted: by the time the real file had learned
// not to claim a Master's degree off the back of a bachelor's, and not to claim a
// certification the CV does not contain, the template still did both — so anyone
// setting the bot up from the template inherited exactly the fabrication bugs that
// had already been fixed. There is now one implementation, and the profile files
// hold nothing but data.
const fs = require('fs');
const config = require('./config');
const policy = require('./question-policy');

// `data` is { skills, certifications, education, employers, summary }.
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
    } catch (e) {
      // No resume text on disk — structured facts above still cover most questions.
    }
    return resumeText;
  }

  // Does the resume/skill list mention this technology? Word-boundary match so "Go"
  // doesn't match "Google" etc.
  function mentionsSkill(text) {
    const needle = String(text || '').trim().toLowerCase();
    if (!needle) return false;
    if (skills.some((s) => s.toLowerCase() === needle)) return true;

    const haystacks = [...skills.map((s) => s.toLowerCase()), loadResumeText().toLowerCase()];
    return haystacks.some((h) => h.includes(needle));
  }

  // Extract the technology/skill name a question is asking about, e.g.
  // "Do you have experience with Kong Gateway?" -> "Kong Gateway"
  // Academic levels, ranked. `education.degreeLevel` was declared but never read,
  // so "Do you have a Master's degree?" answered "Yes" off the back of a bachelor's.
  const DEGREE_LEVELS = [
    { level: 4, pattern: /\b(ph\.?d|doctorate|doctoral)\b/i },
    { level: 3, pattern: /\b(master'?s?|m\.?tech|m\.?sc|m\.?s\.?|mba|m\.?c\.?a|post[- ]?grad\w*)\b/i },
    { level: 2, pattern: /\b(bachelor'?s?|b\.?tech|b\.?e\b|b\.?sc|b\.?c\.?a|undergrad\w*|graduate degree|4[- ]year degree)\b/i },
    { level: 1, pattern: /\b(diploma|associate'?s? degree|polytechnic)\b/i },
    { level: 0, pattern: /\b(high school|higher secondary|12th|hsc|secondary school)\b/i },
  ];

  const OWN_DEGREE_LEVEL = (() => {
    const declared = String(education.degreeLevel || '').toLowerCase();
    const found = DEGREE_LEVELS.find((entry) => entry.pattern.test(declared));
    return found ? found.level : 2;
  })();

  // The highest level the question is asking about, or null if it just says "degree".
  function askedDegreeLevel(question) {
    const hits = DEGREE_LEVELS.filter((entry) => entry.pattern.test(String(question || '')));
    return hits.length ? Math.max(...hits.map((h) => h.level)) : null;
  }

  // Question scaffolding that carries no information about WHICH credential is meant.
  const CERT_STOPWORDS = new Set(
    ('do you have has any all relevant the this that a an of for in with to and or are is hold holding ' +
     'currently valid active please select role position job listed below following required requirement ' +
     'requirements certification certifications certificate certificates certified certification(s) ' +
     'credential credentials license licence licensed licences qualifications qualification your own ' +
     'possess obtained completed which what does').split(/\s+/)
  );

  // True when the question names a *particular* credential rather than asking whether
  // the candidate has any at all. Answering "yes, I have certifications" to "do you
  // hold a PMP?" is a fabricated credential claim, which is worse than a lost job.
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

  // "How many years…", "How many months…", "How long…" — a question wanting a NUMBER.
  // The skill branch below answers yes/no, which is right for "Do you know X?" and
  // nonsense for "How many years of X?" — it used to put the literal string "Yes"
  // into a number field for every CV skill without a configured year count.
  function isQuantityQuestion(text) {
    return /how many|how long|number of years|years? of|months? of|\byears?\b|\bmonths?\b/i.test(
      String(text || '')
    );
  }

  const MONTHS = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };

  function parsePeriodDate(text, { endOfRange = false } = {}) {
    // Bounded before matching: /([A-Za-z]{3,})\s+(\d{4})/ backtracks quadratically
    // on a long run of letters, and a real period string ("September 2024") is a
    // handful of characters. 200 is generous for every date format there is.
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

  // Years spent at one employer, from the `period` string. Answering a tenure
  // question with total career experience is a false statement about employment
  // history — and "how long have you been at your current company?" is a common one.
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

  // Best-effort answer sourced from the CV for questions config.js can't resolve.
  // Returns '' when nothing in the resume is relevant (caller falls back further).
  function answerFromResume(question, inputType = 'text', options = []) {
    const q = String(question || '').toLowerCase();
    const yes = () => findOption(options, /\byes\b/i) || 'Yes';
    const no = () => findOption(options, /\bno\b/i) || 'No';

    // Degree / education questions, answered against the level actually held.
    if (/degree|bachelor|master|phd|doctorate|graduate|qualification|diploma|mba/.test(q)) {
      if (/do you have|have you completed|are you a graduate|do you hold|possess/.test(q) || options.length) {
        const asked = askedDegreeLevel(question);
        if (asked == null) return yes(); // "do you have a degree?" — unqualified
        return OWN_DEGREE_LEVEL >= asked ? yes() : no();
      }
      return education.degree;
    }
    if (/university|college|institution/.test(q)) return education.institution;
    if (/gpa|percentage|cgpa/.test(q) && /education|academic|college|degree/.test(q)) {
      return String(education.gpaPercent);
    }

    // Certification questions.
    const askedCert = certifications.find((c) => q.includes(c.toLowerCase()));
    if (askedCert) return options.length ? yes() : 'Yes';
    // Gated on the classifier so attestation phrasing ("I certify the above is
    // accurate") isn't read as a claim to hold a certification — both contain
    // "certif", and only question-policy.js knows which is which.
    if (/certif\w*|credential|licen[cs]e|accredit/.test(q) && policy.classify(question) === 'capability') {
      // Only a general "do you have any certifications?" gets a yes. A question
      // naming a credential the CV doesn't contain gets an honest no.
      if (namesSpecificCredential(question)) return no();
      return certifications.length ? yes() : no();
    }

    // Skill / technology familiarity questions ("Do you have experience with X?",
    // "Are you proficient in X?", checkbox lists of tech stacks, etc.)
    // Tenure, not total experience. Checked before the skill branch because
    // "how long have you worked at X" contains no skill but plenty of experience words.
    if (policy.isTenureQuestion(question)) {
      const years = tenureYears(employers[0]);
      if (years == null) return '';
      return /months?/.test(q) ? String(Math.round(years * 12)) : String(years);
    }

    const skillFromQuestion = extractSkillFromQuestion(question);
    if (skillFromQuestion) {
      const quantity = isQuantityQuestion(question);
      if (options.length && !quantity) return mentionsSkill(skillFromQuestion) ? yes() : no();
      if (!quantity && /do you|have you|are you|experience|familiar|proficient|skilled|knowledge of/.test(q)) {
        return mentionsSkill(skillFromQuestion) ? 'Yes' : 'No';
      }
      if (quantity) {
        // A CV skill with no configured year count. Only the candidate knows the
        // number, so it is left for them — unless they have stated a fallback.
        const fallback = config.skillExperienceFallbackYears;
        if (Number.isFinite(Number(fallback))) {
          const years = Math.min(Number(fallback), Number(config.experienceYears) || Number(fallback));
          return /months?/.test(q) ? String(Math.round(years * 12)) : String(years);
        }
        return '';
      }
    }

    // A technology that isn't in the skills list at all. "No" is the honest answer
    // and lets the form advance — far better than either claiming it or stalling.
    // Vaguer subjects ("experience in fast-paced environments") are deliberately
    // left unanswered so the candidate decides, once, in config.customAnswers.
    if (policy.classify(question) === 'capability') {
      const subject = policy.extractSubject(question);
      if (subject && policy.looksLikeTechnology(subject)) {
        const known = mentionsSkill(subject);
        if (options.length) return known ? yes() : no();
        if (!/how many|how long|years|months/.test(q)) return known ? 'Yes' : 'No';
      }
    }

    // "How many years of experience do you have with <X>?" where X appears nowhere in
    // the CV. Zero is both true and answerable, which beats stalling the form. A
    // technology the CV DOES mention but has no year count for is left unanswered on
    // purpose — only the candidate knows the number.
    if (/how many years|years of experience|months of experience|years? of work/.test(q)) {
      const subject = policy.extractSubject(question);
      if (subject && policy.looksLikeTechnology(subject) && !mentionsSkill(subject)) {
        return /months?/.test(q) ? '0' : '0';
      }
    }

    // Current/previous employer questions.
    if (/current company|current employer|where do you (currently )?work/.test(q)) {
      return employers[0]?.company || '';
    }
    if (/previous company|previous employer|last company/.test(q)) {
      return employers[1]?.company || '';
    }

    // Open-ended prompts ("tell us about yourself", "professional summary",
    // "why should we hire you") — answer with the resume summary, no LLM involved.
    if (inputType === 'textarea' || /tell us about yourself|professional summary|about you\b/.test(q)) {
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
