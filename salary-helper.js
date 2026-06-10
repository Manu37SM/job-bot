const config = require('./config');

function _parse(ctc) {
  const fixed = parseFloat(ctc.fixed) || 0;
  const variable = parseFloat(ctc.variable) || 0;
  return { fixed, variable, total: parseFloat((fixed + variable).toFixed(2)) };
}

const current = {
  total() {
    return _parse(config.currentCTC).total;
  },
  fixed() {
    return _parse(config.currentCTC).fixed;
  },
  variable() {
    return _parse(config.currentCTC).variable;
  },

  label() {
    return `${this.total()} LPA`;
  },

  full() {
    const { fixed, variable, total } = _parse(config.currentCTC);
    if (variable === 0) return `${total} LPA`;
    return `${total} LPA (${fixed}L fixed + ${variable}L variable)`;
  },

  inRupees() {
    return Math.round(this.total() * 100000);
  },
};

const expected = {
  total() {
    return _parse(config.expectedCTC).total;
  },
  fixed() {
    return _parse(config.expectedCTC).fixed;
  },
  variable() {
    return _parse(config.expectedCTC).variable;
  },

  label() {
    return `${this.total()} LPA`;
  },

  full() {
    const { fixed, variable, total } = _parse(config.expectedCTC);
    if (variable === 0) return `${total} LPA`;
    return `${total} LPA (${fixed}L fixed + ${variable}L variable)`;
  },

  inRupees() {
    return Math.round(this.total() * 100000);
  },
};

function printSalarySummary() {
  console.log(`💰 Current CTC   : ${current.full()}`);
  console.log(`💸 Expected CTC  : ${expected.full()}`);
}

module.exports = { current, expected, printSalarySummary };
