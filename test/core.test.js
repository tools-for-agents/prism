// prism core tests — shape / read / find and their bounding guarantees. Each asserts a CONTRACT
// (the shape names the type, an over-budget read hands back the shape not a truncation, find returns
// paths that read() can actually resolve), so a change that quietly breaks the contract goes red.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shape, read, find, diff, parsePath, estTokens, DEFAULTS } from '../src/core.js';

// ── shape ────────────────────────────────────────────────────────────────────
test('shape names the type of every scalar, and int vs float are distinct', () => {
  const s = shape({ id: 7, price: 9.99, name: 'x', ok: true, gone: null });
  assert.equal(s.type, 'object');
  assert.equal(s.keys, 5);
  assert.equal(s.fields.id.type, 'int');
  assert.equal(s.fields.price.type, 'float');
  assert.equal(s.fields.name.type, 'string');
  assert.equal(s.fields.ok.type, 'bool');
  assert.equal(s.fields.gone.type, 'null');
});

test('shape of an array reports its length and ONE merged element shape, not N shapes', () => {
  const rows = Array.from({ length: 500 }, (_, i) => ({ id: i, tag: 'a' }));
  const s = shape(rows);
  assert.equal(s.type, 'array');
  assert.equal(s.len, 500);                 // the true length, not the sample size
  assert.equal(s.of.type, 'object');
  assert.equal(s.of.fields.id.type, 'int');
  assert.ok(s.sampled <= DEFAULTS.sample);  // honest that `of` came from a sample
  // the descriptor of 500 rows is a handful of tokens, not 500 rows' worth
  assert.ok(estTokens(JSON.stringify(s)) < 120, 'a shape must be tiny regardless of array length');
});

test('shape marks a key that is not in every element as optional', () => {
  const s = shape([{ a: 1, b: 2 }, { a: 1 }, { a: 1 }]);
  assert.equal(s.of.fields.a.optional, undefined); // in all → required
  assert.equal(s.of.fields.b.optional, true);      // in one → optional
});

test('shape reports a mixed-type array honestly instead of pretending it is the first element', () => {
  const s = shape([1, 'two', { three: 3 }]);
  assert.equal(s.of.type, 'mixed');
  assert.deepEqual(s.of.types, ['int', 'object', 'string']);
});

test('shape is DEPTH-BOUNDED — deep nesting truncates instead of recursing forever', () => {
  // build a 100-deep nest; shape must stop at maxDepth and say so, not blow the stack
  let deep = { leaf: 1 };
  for (let i = 0; i < 100; i++) deep = { next: deep };
  const s = shape(deep, { maxDepth: 4 });
  let node = s, depth = 0;
  while (node.fields && node.fields.next) { node = node.fields.next; depth++; }
  assert.ok(depth <= 4, `descent must stop at maxDepth, went ${depth}`);
  assert.equal(node.truncated, true);
});

test('shape of a deep SINGLE-element array chain truncates at maxDepth (merge must keep the flag)', () => {
  // regression: mergeShapes re-derived a 1-element array's shape and dropped `truncated`, so a deep
  // chain descended forever and emitted a bogus "empty" instead of stopping at the cap.
  let chain = [1];
  for (let i = 0; i < 50; i++) chain = [chain];
  const s = shape(chain, { maxDepth: 4 });
  let node = s, depth = 0;
  while (node.of && typeof node.of === 'object') { node = node.of; depth++; }
  assert.ok(depth <= 4, `array descent must stop at maxDepth, went ${depth}`);
  assert.equal(node.truncated, true, 'the deepest shown array must be flagged truncated, not "empty"');
});

test('read of a value too deep to serialise returns its SHAPE, never crashes or returns raw', () => {
  // regression: JSON.stringify is recursive and stack-overflows on deep nesting; read must catch that
  // and hand back the (depth-bounded) shape, not a raw value the caller then re-serialises and dies on.
  let deep = 1;
  for (let i = 0; i < 20000; i++) deep = [deep];
  const r = read({ deep }, 'deep');
  assert.equal(r.found, true);
  assert.equal(r.complete, false);
  assert.equal(r.value, undefined);
  assert.equal(r.shape.type, 'array');
  assert.match(r.note, /deeply nested|shape/i);
  // and it must be JSON-serialisable itself (the CLI/MCP will stringify it)
  assert.doesNotThrow(() => JSON.stringify(r));
});

test('shape is KEY-BOUNDED — a 10k-key object shows maxKeys and withholds the rest with a count', () => {
  const big = {};
  for (let i = 0; i < 10000; i++) big['k' + i] = i;
  const s = shape(big, { maxKeys: 40 });
  assert.equal(s.keys, 10000);                       // the true count
  assert.equal(Object.keys(s.fields).length, 40);    // but only 40 shown
  assert.equal(s.withheld, 9960);                     // and the rest counted, scout's contract
});

// ── path parsing ───────────────────────────────────────────────────────────────
test('parsePath handles dotted keys, [n] indexes, bare-number indexes and [*] wildcards', () => {
  assert.deepEqual(parsePath('a.b.c'), [{ key: 'a' }, { key: 'b' }, { key: 'c' }]);
  assert.deepEqual(parsePath('users[0].name'), [{ key: 'users' }, { index: 0 }, { key: 'name' }]);
  assert.deepEqual(parsePath('users.0.name'), [{ key: 'users' }, { index: 0 }, { key: 'name' }]);
  assert.deepEqual(parsePath('items[*].id'), [{ key: 'items' }, { wild: true }, { key: 'id' }]);
  assert.deepEqual(parsePath('$'), []);
  assert.deepEqual(parsePath(''), []);
});

test('parsePath reads [a:b] slices with either bound optional', () => {
  assert.deepEqual(parsePath('users[0:10]'), [{ key: 'users' }, { slice: [0, 10] }]);
  assert.deepEqual(parsePath('users[:20].level'), [{ key: 'users' }, { slice: [null, 20] }, { key: 'level' }]);
  assert.deepEqual(parsePath('rows[100:]'), [{ key: 'rows' }, { slice: [100, null] }]);
  assert.deepEqual(parsePath('rows[:]'), [{ key: 'rows' }, { slice: [null, null] }]);
  assert.deepEqual(parsePath('$[0:2]'), [{ slice: [0, 2] }]);     // slice straight off an array root
});

// ── read ─────────────────────────────────────────────────────────────────────
const doc = { data: { users: [{ id: 1, email: 'a@x.com' }, { id: 2, email: 'b@x.com' }] }, meta: { n: 2 } };

test('read drills to a path and returns that subtree verbatim when it fits the budget', () => {
  const r = read(doc, 'data.users[0].email');
  assert.equal(r.found, true);
  assert.equal(r.complete, true);
  assert.equal(r.value, 'a@x.com');
  assert.equal(r.type, 'string');
});

test('read with [*] maps over an array and collects the tail path from each element', () => {
  const r = read(doc, 'data.users[*].email');
  assert.equal(r.found, true);
  assert.deepEqual(r.value, ['a@x.com', 'b@x.com']);
  assert.equal(r.count, 2);
});

test('read with [a:b] takes a half-open slice and still collects the tail', () => {
  const big = { xs: Array.from({ length: 12 }, (_, i) => ({ id: i })) };
  assert.deepEqual(read(big, 'xs[0:3]').value.map((o) => o.id), [0, 1, 2]);   // first three
  assert.deepEqual(read(big, 'xs[:2].id').value, [0, 1]);                     // open start + a tail path
  assert.deepEqual(read(big, 'xs[10:]').value.map((o) => o.id), [10, 11]);    // open end (tail of the array)
  assert.equal(read(big, 'xs[0:3]').count, 3);                                // a slice reports its count
});

test('a slice is a "give me up to N", so out-of-range bounds CLAMP instead of erroring', () => {
  const big = { xs: Array.from({ length: 3 }, (_, i) => i) };
  assert.deepEqual(read(big, 'xs[0:100]').value, [0, 1, 2]);   // end past the array → the whole array, not an error
  assert.deepEqual(read(big, 'xs[5:9]').value, []);            // start past the array → empty, not out-of-range
  // ...but an INDEX still asserts existence — the two must not be confused.
  assert.equal(read(big, 'xs[9]').found, false);
});

test('a slice on a non-array is a located error, not a swallowed exception', () => {
  const r = read({ a: 5 }, 'a[0:2]');
  assert.equal(r.found, false);
  assert.match(r.error, /expected array for a slice, found int/);
});

test('parsePath accepts negative indices and negative slice bounds', () => {
  assert.deepEqual(parsePath('logs[-1]'), [{ key: 'logs' }, { index: -1 }]);
  assert.deepEqual(parsePath('logs[-3:]'), [{ key: 'logs' }, { slice: [-3, null] }]);
  assert.deepEqual(parsePath('logs[:-1]'), [{ key: 'logs' }, { slice: [null, -1] }]);
  assert.deepEqual(parsePath('logs[-3:-1]'), [{ key: 'logs' }, { slice: [-3, -1] }]);
});

test('a negative index counts from the end, and a negative slice bound does too', () => {
  const big = { xs: Array.from({ length: 12 }, (_, i) => i) };
  assert.equal(read(big, 'xs[-1]').value, 11);                    // last element
  assert.equal(read(big, 'xs[-12]').value, 0);                    // first, reached from the end
  assert.deepEqual(read(big, 'xs[-3:]').value, [9, 10, 11]);      // the last three
  assert.deepEqual(read(big, 'xs[:-10]').value, [0, 1]);          // all but the last ten
  assert.deepEqual(read(big, 'xs[-100:]').value, big.xs);         // a negative start past the front clamps to 0
});

test('an out-of-range negative index is a located error naming the valid window', () => {
  const r = read({ xs: [1, 2, 3] }, 'xs[-9]');
  assert.equal(r.found, false);
  assert.match(r.error, /index in \[-3, 3\)/);       // both bounds named, so the agent knows the window
  assert.match(r.error, /out of range/);
});

test('read of the root ($) returns the whole value when small', () => {
  const r = read({ a: 1 }, '$');
  assert.equal(r.found, true);
  assert.deepEqual(r.value, { a: 1 });
});

test('read NAMES where a bad path fell off — a wrong key is a fact, not a thrown error', () => {
  const r = read(doc, 'data.nope.x');
  assert.equal(r.found, false);
  assert.match(r.error, /data\.nope/);
  assert.match(r.error, /missing|existing key/);
});

test('read into a scalar as if it were an object fails with the type it actually found', () => {
  const r = read(doc, 'meta.n.deeper');
  assert.equal(r.found, false);
  assert.match(r.error, /int/);
});

test('an OVER-BUDGET read hands back the SHAPE plus the honest size — never a silent truncation', () => {
  const big = { rows: Array.from({ length: 2000 }, (_, i) => ({ id: i, blob: 'x'.repeat(50) })) };
  const r = read(big, 'rows', { budget: 100 });
  assert.equal(r.found, true);
  assert.equal(r.complete, false);
  assert.ok(r.tokens > 100);
  assert.ok(r.withheld_tokens > 0);
  assert.equal(r.value, undefined, 'an over-budget read must NOT include the value');
  assert.equal(r.shape.type, 'array');
  assert.equal(r.shape.len, 2000);          // the shape still tells the true size
  assert.match(r.note, /shape|narrow/i);
});

// ── find ─────────────────────────────────────────────────────────────────────
test('find locates a KEY and returns a path that read() can resolve', () => {
  const r = find(doc, 'email');
  assert.ok(r.matched >= 2);
  const p = r.hits.find((h) => h.kind === 'key').path;
  const back = read(doc, p);
  assert.equal(back.found, true, `find returned path ${p} but read could not resolve it`);
});

test('find locates a VALUE by substring and reports its path and preview', () => {
  const r = find(doc, 'b@x.com');
  const hit = r.hits.find((h) => h.kind === 'value');
  assert.ok(hit, 'the value should be found');
  assert.equal(hit.preview, 'b@x.com');
  assert.equal(read(doc, hit.path).value, 'b@x.com');
});

test('on an ARRAY root, find and diff emit paths read() can resolve — no bogus $ key', () => {
  // regression: an array root produced `$[1].email`, and read() parsed the leading $ as a KEY and
  // failed. It only bit array-root data (which CSV always is). find/diff drop the $ at root now.
  const rows = [{ email: 'a@x' }, { email: 'b@x' }];
  const fp = find(rows, 'b@x').hits[0].path;
  assert.equal(fp, '[1].email');
  assert.equal(read(rows, fp).found, true);
  const dp = diff([{ v: 1 }], [{ v: 2 }]).changes[0].path;
  assert.equal(dp, '[0].v');
  assert.equal(read([{ v: 2 }], dp).value, 2);
  // read also accepts the $-prefixed form
  assert.equal(read(rows, '$[0].email').value, 'a@x');
});

test('find matches numbers EXACTLY so "1" does not also match "1000"', () => {
  const r = find({ a: 1, b: 1000, c: 21 }, '1');
  const vals = r.hits.filter((h) => h.kind === 'value').map((h) => h.path);
  assert.deepEqual(vals.sort(), ['a']);   // only the exact 1, not 1000 or 21
});

test('find is NODE-BOUNDED — it stops after maxNodes and says the result may be partial', () => {
  const big = {};
  for (let i = 0; i < 5000; i++) big['k' + i] = { needle: i };
  const r = find(big, 'needle', { maxNodes: 200 });
  assert.equal(r.truncated, true);
  assert.ok(r.visited <= 200 + 1);
  assert.match(r.note, /narrow|more/i);
});

test('find caps the number of hits returned but reports how many it withheld', () => {
  const rows = Array.from({ length: 300 }, () => ({ email: 'z@x.com' }));
  const r = find({ rows }, 'email', { maxHits: 10 });
  assert.equal(r.returned, 10);
  assert.ok(r.matched >= 300);
  assert.equal(r.withheld, r.matched - 10);
});

test('find on an empty query refuses rather than matching everything', () => {
  const r = find(doc, '');
  assert.equal(r.error, 'empty query');
  assert.deepEqual(r.hits, []);
});
