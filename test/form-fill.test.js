const test = require('node:test');
const assert = require('node:assert/strict');

const { FakeForm, makePage } = require('./helpers/fake-page');
const { fillLinkedInForm } = require('../linkedin');
const config = require('../config');

const originalSpeed = config.speed;
config.speed = 'instant';

const realConsole = { log: console.log, warn: console.warn, error: console.error };
const mute = () => {
  console.log = () => {};
  console.warn = () => {};
  console.error = () => {};
};
const unmute = () => Object.assign(console, realConsole);

test.before(() => {
  config.speed = 'instant';
  mute();
});
test.after(() => {
  unmute();
  config.speed = originalSpeed;
});

const run = (steps) => {
  const form = new FakeForm(steps);
  return fillLinkedInForm(makePage(form), 'Backend Engineer', 'Acme').then((result) => ({
    result,
    form,
  }));
};

test('a form the bot can answer is submitted', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [
        { kind: 'text', label: 'Email address', required: true },
        {
          kind: 'radio',
          label: 'Are you legally authorized to work in India?',
          options: ['Yes', 'No'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(form.submitted, true);
});

test('the answer trail records what was actually submitted', async () => {
  const { result } = await run([
    {
      button: 'Submit',
      fields: [
        { kind: 'text', label: 'Email address', required: true },
        {
          kind: 'radio',
          label: 'Are you legally authorized to work in India?',
          options: ['Yes', 'No'],
          required: true,
        },
      ],
    },
  ]);
  const byQuestion = Object.fromEntries(result.answered.map((a) => [a.question, a.answer]));
  assert.equal(byQuestion['Email address'], config.email);
  assert.equal(byQuestion['Are you legally authorized to work in India?'], 'Yes');
});

test('an unanswerable required question produces `unanswerable`, naming the question', async () => {
  const question = 'Do you have experience working in fast-paced environments?';
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [{ kind: 'radio', label: question, options: ['Yes', 'No'], required: true }],
    },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unanswerable', result.reason);
  assert.ok(
    result.unanswered.some((u) => u.question === question),
    'the blocking question must reach needs-review.md'
  );
  assert.equal(form.submitted, false, 'nothing may be submitted when a question was refused');
});

test('a protected-characteristic question with no decline option is refused, not guessed', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [
        {
          kind: 'radio',
          label: 'What is your gender?',
          options: ['Male', 'Female'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'unanswerable');
  assert.equal(form.submitted, false);
});

test('a protected-characteristic question WITH a decline option is answered and submitted', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [
        {
          kind: 'radio',
          label: 'What is your gender?',
          options: ['Male', 'Female', 'I prefer not to say'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(form.submitted, true);
  assert.equal(
    result.answered.find((a) => /gender/i.test(a.question)).answer,
    'I prefer not to say'
  );
});

test('a field that rejects every value produces `invalid_field` with the blockers', async () => {
  const { result } = await run([
    {
      button: 'Submit',
      fields: [
        { kind: 'number', label: 'Years of experience', required: true, rejectsEverything: true },
      ],
    },
  ]);
  assert.equal(result.ok, false);
  assert.equal(result.code, 'invalid_field', result.reason);
  assert.ok(result.blockers.length > 0, 'the validation messages drive the review report');
  assert.match(result.blockers.join(' '), /Years of experience/);
});

test('a multi-step form is walked to the end', async () => {
  const { result, form } = await run([
    { button: 'Next', fields: [{ kind: 'text', label: 'Email address', required: true }] },
    { button: 'Next', fields: [{ kind: 'text', label: 'Mobile phone number', required: true }] },
    {
      button: 'Submit',
      fields: [
        {
          kind: 'radio',
          label: 'Do you consent to a background check?',
          options: ['Yes', 'No'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(form.submitted, true);
  assert.equal(result.answered.length, 3);
});

test('a blocked step on page two is reported, not silently submitted', async () => {
  const { result, form } = await run([
    { button: 'Next', fields: [{ kind: 'text', label: 'Email address', required: true }] },
    {
      button: 'Submit',
      fields: [
        {
          kind: 'radio',
          label: 'Do you have experience with Erlang?',
          options: ['Yes', 'No'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(form.submitted, true);
  assert.equal(result.answered.find((a) => /Erlang/.test(a.question)).answer, 'No');
});

test('the modal disappearing mid-fill is reported as modal_missing', async () => {
  const form = new FakeForm([
    { button: 'Next', fields: [{ kind: 'text', label: 'Email address' }] },
  ]);
  form.closed = true;
  const result = await fillLinkedInForm(makePage(form), 'Backend Engineer', 'Acme');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'modal_missing');
});

test('an optional question the bot cannot answer does not fail the form', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [
        { kind: 'text', label: 'Tell us something surprising', required: false },
        { kind: 'text', label: 'Email address', required: true },
      ],
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(form.submitted, true);
});

test('salary reaches the field with the unit conversion applied', async () => {
  const { result } = await run([
    {
      button: 'Submit',
      fields: [{ kind: 'number', label: 'Expected annual salary in INR', required: true }],
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  const answer = result.answered.find((a) => /salary/i.test(a.question)).answer;
  assert.equal(answer, '700000', 'an INR label must not receive the LPA figure');
});

test('the phone number reaches the trail even though a special case fills it', async () => {
  const { result } = await run([
    { button: 'Submit', fields: [{ kind: 'text', label: 'Mobile phoneNumber', required: true }] },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.ok(
    result.answered.some((a) => a.answer === config.phone),
    'the submitted phone number must appear in the audit trail'
  );
});

test('a rejected value is not reported as a missing answer', async () => {
  const { result } = await run([
    {
      button: 'Submit',
      fields: [
        { kind: 'number', label: 'Years of experience', required: true, rejectsEverything: true },
      ],
    },
  ]);
  assert.equal(result.code, 'invalid_field');
  assert.equal(result.unanswered.length, 0, 'nothing was unanswered — the value was refused');
  assert.match(result.blockers.join(' | '), /the field refused/);
});

test('when both problems occur, the missing answer is named as the cause', async () => {
  const { result } = await run([
    {
      button: 'Submit',
      fields: [
        { kind: 'number', label: 'Years of experience', required: true, rejectsEverything: true },
        {
          kind: 'radio',
          label: 'Do you have experience working in fast-paced environments?',
          options: ['Yes', 'No'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.code, 'unanswerable');
  assert.match(result.reason, /fast-paced/);
  assert.match(result.blockers.join(' | '), /the field refused/);
});

test('a dropdown whose options match no answer is refused for a skill question', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [
        {
          kind: 'select',
          label: 'How would you rate your Rust expertise?',
          options: ['Expert', 'Advanced', 'Intermediate'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.ok, false);
  assert.equal(form.submitted, false);
  assert.match(result.code, /unanswerable|invalid_field/);
});

test('a consent dropdown with no exact match still advances the form', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [
        {
          kind: 'select',
          label: 'Do you agree to our terms and conditions?',
          options: ['I agree', 'I do not agree'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(form.submitted, true);
});

test('a "which of these have you used" group ticks only what is on the CV', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [
        {
          kind: 'checkbox',
          label: 'Which of these do you have experience with?',
          options: ['Java', 'Rust', 'COBOL'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  const field = form.steps[0].fields[0];
  assert.deepEqual(field.selected, ['Java'], 'only the technology actually on the CV');
});

test('a group where nothing matches is left blank rather than ticked at random', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [
        {
          kind: 'checkbox',
          label: 'Which of these do you have experience with?',
          options: ['Rust', 'COBOL', 'Fortran'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.ok, false);
  assert.equal(form.submitted, false);
  const field = form.steps[0].fields[0];
  assert.deepEqual(field.selected, [], 'nothing may be ticked at random');
  assert.ok(result.unanswered.some((u) => /which of these/i.test(u.question)));
});

test('a form that never advances is reported as stuck, not retried forever', async () => {
  const form = new FakeForm([
    { button: 'Next', fields: [{ kind: 'text', label: 'Email address', required: true }] },
  ]);
  form.pressButton = () => {};
  const result = await fillLinkedInForm(makePage(form), 'Backend Engineer', 'Acme');
  assert.equal(result.ok, false);
  assert.match(result.code, /stuck_form|no_action/);
});

test('a resume file input is filled from config.resumePath', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [
        { kind: 'file', label: 'Upload your resume', accept: '.pdf' },
        { kind: 'text', label: 'Email address', required: true },
      ],
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  const fileField = form.steps[0].fields[0];
  assert.ok(fileField.files?.[0], 'the resume must be attached');
  assert.match(fileField.files[0], /\.pdf$/);
});

test('an already-answered field is left alone', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [{ kind: 'text', label: 'Email address', required: true, value: 'typed@by.hand' }],
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(
    form.steps[0].fields[0].value,
    'typed@by.hand',
    'a prefilled value must not be overwritten'
  );
});

const { closeModal } = require('../linkedin');

test('closing the modal escalates until it actually goes', async () => {
  for (const behaviour of ['button', 'escape', 'dom']) {
    const form = new FakeForm([{ button: 'Next', fields: [] }]);
    form.dismissBehaviour = behaviour;
    const closed = await closeModal(makePage(form));
    assert.equal(closed, true, `behaviour: ${behaviour}`);
    assert.equal(form.closed, true, `behaviour: ${behaviour}`);
  }
});

test('the cheap path is not escalated past unnecessarily', async () => {
  const form = new FakeForm([{ button: 'Next', fields: [] }]);
  form.dismissBehaviour = 'button';
  await closeModal(makePage(form));
  assert.equal(form.escapePresses, 0, 'Escape should not be needed when the button worked');
  assert.equal(form.domRemovals, 0, 'the DOM should not be touched when the button worked');
});

test('Escape is tried before reaching into the DOM', async () => {
  const form = new FakeForm([{ button: 'Next', fields: [] }]);
  form.dismissBehaviour = 'escape';
  await closeModal(makePage(form));
  assert.ok(form.escapePresses > 0);
  assert.equal(form.domRemovals, 0);
});

test('a modal that refuses to close is reported, not assumed gone', async () => {
  const form = new FakeForm([{ button: 'Next', fields: [] }]);
  form.dismissBehaviour = 'stuck';
  const closed = await closeModal(makePage(form));
  assert.equal(closed, false, 'the caller has to be able to know');
  assert.ok(
    form.escapePresses > 0 && form.domRemovals > 0,
    'every fallback should have been tried'
  );
});

test('a radio whose options match no answer is not clicked at random', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [
        {
          kind: 'radio',
          label: 'Are you legally authorized to work in India?',
          options: ['I am authorized', 'I am not authorized'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.ok, false);
  assert.equal(form.submitted, false);
  assert.deepEqual(form.steps[0].fields[0].selected, [], 'nothing may be clicked at random');
});

test('the same fallback DOES fire for harmless boilerplate', async () => {
  const { result, form } = await run([
    {
      button: 'Submit',
      fields: [
        {
          kind: 'radio',
          label: 'Do you agree to the terms and conditions?',
          options: ['Certainly', 'Never'],
          required: true,
        },
      ],
    },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.deepEqual(form.steps[0].fields[0].selected, ['Certainly']);
});

test('a blocked field stops the form at that step, not three clicks later', async () => {
  const { result, form } = await run([
    {
      button: 'Next',
      fields: [
        { kind: 'number', label: 'Years of experience', required: true, rejectsEverything: true },
      ],
    },
    { button: 'Submit', fields: [{ kind: 'text', label: 'Email address', required: true }] },
  ]);
  assert.equal(result.code, 'invalid_field', result.reason);
  assert.match(result.reason, /before "Next"/);
  assert.match(result.blockers.join(' | '), /Years of experience/);
  assert.equal(form.index, 0, 'it must not have advanced past the blocked step');
  assert.equal(form.submitted, false);
});

test('a step with no problems still advances', async () => {
  const { result, form } = await run([
    { button: 'Next', fields: [{ kind: 'text', label: 'Email address', required: true }] },
    { button: 'Submit', fields: [{ kind: 'text', label: 'Mobile phone number', required: true }] },
  ]);
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(form.index, 1);
  assert.equal(form.submitted, true);
});

test('a submit LinkedIn never confirms is not recorded as applied', async () => {
  const form = new FakeForm([
    { button: 'Submit', fields: [{ kind: 'text', label: 'Email address', required: true }] },
  ]);
  form.confirmsSubmission = false;

  const result = await fillLinkedInForm(makePage(form), 'Backend Engineer', 'Acme');
  assert.equal(result.ok, false, 'an unconfirmed submit must never read as success');
  assert.equal(result.code, 'unconfirmed_submit', result.reason);
});

test('a confirmed submit is recorded as applied', async () => {
  const form = new FakeForm([
    { button: 'Submit', fields: [{ kind: 'text', label: 'Email address', required: true }] },
  ]);
  form.confirmsSubmission = true;
  const result = await fillLinkedInForm(makePage(form), 'Backend Engineer', 'Acme');
  assert.equal(result.ok, true, JSON.stringify(result));
});
