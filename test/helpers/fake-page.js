let idCounter = 0;
const nextId = () => `f${++idCounter}`;

const fieldsById = new Map();

function installDocument() {
  if (global.document && global.document.__fake) return;
  global.document = {
    __fake: true,
    querySelector(selector) {
      const match = /label\[for="([^"]+)"\]/.exec(selector);
      if (!match) return null;
      const field = fieldsById.get(match[1]);
      return field ? { innerText: field.label } : null;
    },
    querySelectorAll: () => [],
    body: { innerText: '' },
  };
}

class Field {
  constructor(spec) {
    Object.assign(this, {
      kind: 'text',
      label: '',
      options: [],
      required: false,
      value: '',
      checked: false,
      selected: [],
      ariaInvalid: false,
      combobox: false,
      rejectsEverything: false,
      step: '',
      id: nextId(),
      ...spec,
    });
    fieldsById.set(this.id, this);
    installDocument();
  }

  get isTextual() {
    return this.kind === 'text' || this.kind === 'number';
  }

  get isInvalid() {
    if (this.ariaInvalid) return true;
    if (this.rejectsEverything) return true;
    if (!this.required) return false;
    if (this.kind === 'radio' || this.kind === 'checkbox') return this.selected.length === 0;
    return !String(this.value || '').trim();
  }

  validationMessage() {
    if (this.rejectsEverything) return 'Please enter a valid value';
    return 'Please fill in this field';
  }
}

class Handle {
  constructor(field, form, role = 'field') {
    this.field = field;
    this.form = form;
    this.role = role;
    this.optionText = '';
  }

  async isVisible() {
    return true;
  }

  async inputValue() {
    return this.field.value;
  }

  async fill(text) {
    if (this.field.rejectsEverything) {
      this.field.value = '';
      return;
    }
    this.field.value = String(text);
  }

  async click() {
    if (this.role === 'button') {
      this.form.pressButton(this.field);
      return;
    }
    if (this.role === 'option') {
      const field = this.field;
      if (field.kind === 'radio') field.selected = [this.optionText];
      else if (!field.selected.includes(this.optionText)) field.selected.push(this.optionText);
      return;
    }
    if (this.field.kind === 'checkbox') this.field.checked = true;
  }

  async isChecked() {
    return this.field.checked;
  }

  async innerText() {
    if (this.role === 'option') return this.optionText;
    return this.field.label;
  }

  async setInputFiles(path) {
    this.field.files = [path];
  }

  async evaluate(fn, arg) {
    const field = this.field;
    const element = {
      id: field.id,
      name: field.label,
      type: field.kind === 'number' ? 'number' : field.kind === 'textarea' ? 'textarea' : 'text',
      value: field.value,
      placeholder: field.label,
      required: field.required,
      files: field.files || [],
      innerText: this.role === 'option' ? this.optionText : field.label,
      options: field.options.map((text) => ({ text })),
      offsetParent: {},
      getAttribute(name) {
        if (name === 'aria-label') return this.__ariaLabel || null;
        if (name === 'step') return field.step || '';
        if (name === 'pattern' || name === 'min' || name === 'max') return '';
        if (name === 'accept') return field.accept || '';
        if (name === 'aria-required') return field.required ? 'true' : 'false';
        if (name === 'role') return field.combobox ? 'combobox' : null;
        if (name === 'aria-invalid') return field.ariaInvalid ? 'true' : 'false';
        return null;
      },
      hasAttribute: (name) => name === 'aria-autocomplete' && field.combobox,
      closest: () => null,
      checkValidity: () => !field.rejectsEverything,
      dispatchEvent: () => true,
    };
    element.__ariaLabel = this.role === 'button' ? field.label : null;

    return fn(element, arg);
  }

  async selectOption(spec) {
    const label = typeof spec === 'string' ? spec : spec.label;
    this.field.value = label;
    this.field.selected = [label];
  }

  async $$(selector) {
    return this.form.queryAll(selector, this.field);
  }

  async $eval(selector, fn) {
    const [first] = this.form.queryAll(selector, this.field);
    if (!first) throw new Error(`no match for ${selector}`);
    return first.evaluate(fn);
  }

  async $$eval(selector, fn, arg) {
    const handles = this.form.queryAll(selector, this.field);
    const elements = await Promise.all(
      handles.map(async (h) => ({
        innerText: await h.innerText(),
        offsetParent: {},
        id: h.field.id,
        validationMessage: h.field.validationMessage(),
        getAttribute: (n) => (n === 'placeholder' || n === 'name' ? h.field.label : null),
      }))
    );
    return fn(elements, arg);
  }

  async scrollIntoViewIfNeeded() {}
}

class FakeForm {
  constructor(steps) {
    this.steps = steps.map((step) => ({
      button: step.button || 'Next',
      fields: (step.fields || []).map((f) => new Field(f)),
    }));
    this.index = 0;
    this.submitted = false;
    this.closed = false;
    this.blockedClicks = 0;
    this.dismissBehaviour = 'button';
    this.confirmsSubmission = true;
    this.escapePresses = 0;
    this.domRemovals = 0;
  }

  get current() {
    return this.steps[this.index];
  }

  pressButton(buttonField) {
    const blocking = this.current.fields.filter((f) => f.isInvalid);
    if (blocking.length) {
      this.blockedClicks++;
      return;
    }
    if (buttonField.label === 'Submit application') {
      this.submitted = true;
      this.closed = true;
      return;
    }
    if (this.index < this.steps.length - 1) this.index++;
  }

  matchesButton(selector) {
    const label = this.current.button === 'Submit' ? 'Submit application' : 'Continue to next step';
    if (this.current.button === 'Submit') {
      if (/Submit application/.test(selector)) return label;
      return null;
    }
    if (/Continue to next step|has-text\("Next"\)|Review/.test(selector)) return label;
    return null;
  }

  queryAll(selector, scopeField) {
    const fields = this.closed ? [] : this.current.fields;

    if (scopeField && /data-test-text-selectable-option__label/.test(selector)) {
      return scopeField.options.map((text) => {
        const handle = new Handle(scopeField, this, 'option');
        handle.optionText = text;
        return handle;
      });
    }
    if (scopeField && selector === 'label') {
      return scopeField.options.map((text) => {
        const handle = new Handle(scopeField, this, 'option');
        handle.optionText = text;
        return handle;
      });
    }
    if (scopeField && /input\[type="radio"\]:checked/.test(selector)) {
      return scopeField.kind === 'radio' && scopeField.selected.length
        ? [new Handle(scopeField, this)]
        : [];
    }
    if (scopeField && /input\[type="radio"\]/.test(selector)) {
      return scopeField.kind === 'radio'
        ? scopeField.options.map(() => new Handle(scopeField, this))
        : [];
    }
    if (scopeField && /input\[type="checkbox"\]:checked/.test(selector)) {
      return scopeField.kind === 'checkbox' && scopeField.selected.length
        ? [new Handle(scopeField, this)]
        : [];
    }
    if (scopeField && /input\[type="checkbox"\]/.test(selector)) {
      return scopeField.kind === 'checkbox'
        ? scopeField.options.map(() => new Handle(scopeField, this))
        : [];
    }
    if (scopeField && /legend|data-test-form-element-label/.test(selector)) {
      return [new Handle(scopeField, this)];
    }

    if (/data-test-form-element/.test(selector)) {
      return fields
        .filter((f) => f.kind === 'radio' || f.kind === 'checkbox')
        .map((f) => new Handle(f, this));
    }
    if (/input:invalid/.test(selector)) {
      return fields.filter((f) => f.isInvalid).map((f) => new Handle(f, this));
    }
    if (/input\[type="file"\]/.test(selector)) {
      return fields.filter((f) => f.kind === 'file').map((f) => new Handle(f, this));
    }
    if (/input\[type="text"\], input\[type="number"\]/.test(selector)) {
      return fields.filter((f) => f.isTextual).map((f) => new Handle(f, this));
    }
    if (selector === 'textarea') {
      return fields.filter((f) => f.kind === 'textarea').map((f) => new Handle(f, this));
    }
    if (selector === 'select') {
      return fields.filter((f) => f.kind === 'select').map((f) => new Handle(f, this));
    }
    if (/input\[type="checkbox"\]/.test(selector)) {
      return fields.filter((f) => f.kind === 'checkbox').map((f) => new Handle(f, this));
    }
    if (/role="listbox"/.test(selector)) return [];
    return [];
  }

  queryOne(selector) {
    if (this.closed) return null;
    if (/input\[id\*="phoneNumber"\]/.test(selector)) {
      const field = this.current.fields.find((f) => /phone/i.test(f.label) && f.kind !== 'select');
      return field ? new Handle(field, this) : null;
    }
    if (/phoneNumber-country|phoneNumberCountryCode/.test(selector)) {
      const field = this.current.fields.find((f) => /country code/i.test(f.label));
      return field ? new Handle(field, this) : null;
    }
    if (/aria-label="Dismiss"/.test(selector)) return null;

    const buttonLabel = this.matchesButton(selector);
    if (buttonLabel) {
      return new Handle(new Field({ kind: 'button', label: buttonLabel }), this, 'button');
    }
    const [first] = this.queryAll(selector);
    return first || null;
  }
}

function makePage(form) {
  const modal = {
    $: async (selector) => form.queryOne(selector),
    $$: async (selector) => form.queryAll(selector),
    $eval: async (selector, fn) => {
      const [first] = form.queryAll(selector);
      if (!first) throw new Error('no match');
      return first.evaluate(fn);
    },
    $$eval: async (selector, fn, arg) => {
      const handles = form.queryAll(selector);
      const elements = await Promise.all(
        handles.map(async (h) => ({
          innerText: await h.innerText(),
          offsetParent: {},
          id: h.field.id,
          type: h.field.kind,
          value: h.field.value,
          validationMessage: h.field.validationMessage(),
          getAttribute: (n) => {
            if (n === 'placeholder' || n === 'name' || n === 'aria-label') return h.field.label;
            return null;
          },
        }))
      );
      return fn(elements, arg);
    },
    evaluate: async (fn) => fn({ querySelectorAll: () => [] }),
  };

  return {
    form,
    $: async (selector) => {
      if (/easy-apply-modal/.test(selector)) return form.closed ? null : modal;
      return form.queryOne(selector);
    },
    $$: async (selector) => form.queryAll(selector),
    evaluate: async () => {
      form.domRemovals++;
      if (form.dismissBehaviour === 'dom') form.closed = true;
      return false;
    },
    keyboard: {
      press: async (key) => {
        if (key !== 'Escape') return;
        form.escapePresses++;
        if (form.dismissBehaviour === 'escape') form.closed = true;
      },
    },
    click: async (selector) => {
      if (
        form.dismissBehaviour === 'button' &&
        /Dismiss|Discard|discard_application/.test(selector)
      ) {
        form.closed = true;
      }
    },
    locator: (selector) => {
      const isConfirmation = /application \(was \)\?sent|application submitted/.test(
        String(selector)
      );
      const node = {
        isVisible: async () => isConfirmation && form.submitted && form.confirmsSubmission,
        click: async () => {},
        innerText: async () => '',
        count: async () => 0,
        first: () => node,
        nth: () => node,
      };
      return node;
    },
  };
}

module.exports = { FakeForm, makePage, Field };
