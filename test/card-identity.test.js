const test = require('node:test');
const assert = require('node:assert/strict');
const { readCardIdentity } = require('../linkedin');

function fakeCard(node) {
  return {
    evaluate: async (fn) => fn(node),
  };
}

function element({ attrs = {}, children = {} } = {}) {
  return {
    getAttribute: (name) => attrs[name] ?? null,
    querySelector: (selector) => {
      for (const [key, value] of Object.entries(children)) {
        if (selector.includes(key)) return value;
      }
      return null;
    },
  };
}

test('the id is read from data-job-id', async () => {
  const card = fakeCard(element({ attrs: { 'data-job-id': '4458068238' } }));
  assert.equal((await readCardIdentity(card)).jobId, '4458068238');
});

test('the id falls back through the other places LinkedIn puts it', async () => {
  const occludable = fakeCard(element({ attrs: { 'data-occludable-job-id': '123' } }));
  assert.equal((await readCardIdentity(occludable)).jobId, '123');

  const nested = fakeCard(
    element({ children: { '[data-job-id]': { getAttribute: () => '456' } } })
  );
  assert.equal((await readCardIdentity(nested)).jobId, '456');

  const fromHref = fakeCard(
    element({
      children: {
        'a[href*="/jobs/view/"]': {
          getAttribute: () => '/jobs/view/789/?trk=flagship',
          innerText: 'Backend Engineer',
        },
      },
    })
  );
  assert.equal((await readCardIdentity(fromHref)).jobId, '789');
});

test('a card with no id anywhere returns empty rather than throwing', async () => {
  const bare = fakeCard(element());
  assert.deepEqual(await readCardIdentity(bare), { jobId: '', title: '', company: '' });
});

test('an element that throws is handled, not propagated', async () => {
  const hostile = {
    evaluate: async () => {
      throw new Error('detached from DOM');
    },
  };
  assert.deepEqual(await readCardIdentity(hostile), { jobId: '', title: '', company: '' });
});

test('title and company come off the card too', async () => {
  const card = fakeCard(
    element({
      attrs: { 'data-job-id': '1' },
      children: {
        '.job-card-list__title': { innerText: '  Senior Backend Engineer \n' },
        '.job-card-container__primary-description': { innerText: ' Acme Corp \n' },
      },
    })
  );
  const identity = await readCardIdentity(card);
  assert.equal(identity.title, 'Senior Backend Engineer');
  assert.equal(identity.company, 'Acme Corp');
});

test('a missing title or company is empty, not undefined', async () => {
  const card = fakeCard(element({ attrs: { 'data-job-id': '1' } }));
  const identity = await readCardIdentity(card);
  assert.equal(identity.title, '');
  assert.equal(identity.company, '');
});
