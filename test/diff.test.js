// prism diff tests — comparing two structured blobs. The contract: it reports the PATHS that
// changed (added / removed / a scalar that moved), objects by key and arrays by index, with a
// complete summary count even when the returned list is capped — and it is bounded, because it
// diffs untrusted data.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diff } from '../src/core.js';

test('two identical documents diff to nothing, and say so', () => {
  const d = diff({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] });
  assert.equal(d.identical, true);
  assert.equal(d.total, 0);
  assert.deepEqual(d.changes, []);
});

test('an added key, a removed key, and a changed scalar are each named at their path', () => {
  const d = diff({ keep: 1, gone: 2, moved: 3 }, { keep: 1, moved: 4, fresh: 5 });
  assert.equal(d.identical, false);
  assert.equal(d.added, 1);
  assert.equal(d.removed, 1);
  assert.equal(d.changed, 1);
  const by = Object.fromEntries(d.changes.map((c) => [c.path, c]));
  assert.equal(by.fresh.kind, 'added');
  assert.equal(by.fresh.to, 5);
  assert.equal(by.gone.kind, 'removed');
  assert.equal(by.gone.from, 2);
  assert.equal(by.moved.kind, 'changed');
  assert.equal(by.moved.from, 3);
  assert.equal(by.moved.to, 4);
});

test('arrays are compared by INDEX — a changed element, and a longer array, are reported per position', () => {
  const d = diff({ xs: [1, 2, 3] }, { xs: [1, 9, 3, 4] });
  const by = Object.fromEntries(d.changes.map((c) => [c.path, c]));
  assert.equal(by['xs[1]'].kind, 'changed');
  assert.equal(by['xs[1]'].to, 9);
  assert.equal(by['xs[3]'].kind, 'added');
  assert.equal(by['xs[3]'].to, 4);
  assert.equal(d.changed, 1);
  assert.equal(d.added, 1);
});

test('a value that CHANGED TYPE is one "changed", not an add plus a remove', () => {
  const d = diff({ v: 'hi' }, { v: { nested: true } });
  assert.equal(d.total, 1);
  assert.equal(d.changed, 1);
  assert.equal(d.changes[0].kind, 'changed');
  assert.equal(d.changes[0].path, 'v');
});

test('nested changes carry the full dotted/indexed path', () => {
  const d = diff({ data: { users: [{ id: 1, email: 'a@x' }] } },
                 { data: { users: [{ id: 1, email: 'b@x' }] } });
  assert.equal(d.total, 1);
  assert.equal(d.changes[0].path, 'data.users[0].email');
  assert.equal(d.changes[0].from, 'a@x');
  assert.equal(d.changes[0].to, 'b@x');
});

test('diff is HIT-BOUNDED — the returned list caps at maxHits but the summary counts are complete', () => {
  const a = {}, b = {};
  for (let i = 0; i < 300; i++) { a['k' + i] = i; b['k' + i] = i + 1; }   // all 300 changed
  const d = diff(a, b, { maxHits: 10 });
  assert.equal(d.changed, 300);          // the count is the truth
  assert.equal(d.returned, 10);          // the list is capped
  assert.equal(d.withheld, 290);
});

test('diff is NODE-BOUNDED — it stops after maxNodes and says the result may be partial', () => {
  const a = {}, b = {};
  for (let i = 0; i < 5000; i++) { a['k' + i] = { v: i }; b['k' + i] = { v: i + 1 }; }
  const d = diff(a, b, { maxNodes: 200 });
  assert.equal(d.truncated, true);
  assert.match(d.note, /more differences/);
});

test('int and float that are numerically equal do not register as a change', () => {
  // 1 and 1.0 are the same Number in JS/JSON — diff must not invent a change
  const d = diff({ n: 1 }, { n: 1.0 });
  assert.equal(d.identical, true);
});
