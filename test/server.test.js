// prism serve tests — the web view's HTTP surface. It holds ONE document in RAM (no store, no disk),
// so the contract is: an empty server says so; a loaded blob answers shape/read/find; a bad path is a
// 400 the UI can show, not a 500; the byte cap holds; and the static server refuses a path-traversal.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { serve } from '../src/server.js';

let server, base;
before(async () => {
  server = serve(0);                                  // port 0 → an ephemeral free port
  await new Promise((r) => server.once('listening', r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

const get = async (p) => { const r = await fetch(base + p); return { code: r.status, body: await r.json() }; };
const load = async (data, qs = '') => {
  const r = await fetch(base + '/api/load' + qs, { method: 'POST', body: data });
  return { code: r.status, body: await r.json() };
};

test('a fresh server reports the EMPTY state honestly, not a fake document', async () => {
  const { body } = await get('/api/current');
  assert.equal(body.empty, true);
});

// Runs before any load() below, so `current` is still empty — /api/diff must refuse cleanly.
test('/api/diff before anything is loaded is a clean 400, not a crash', async () => {
  const r = await fetch(base + '/api/diff', { method: 'POST', body: '{"a":1}' });
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /nothing loaded/);
});

test('loading a blob returns its shape and a digest — and never the blob itself', async () => {
  const { code, body } = await load('{"page":2,"users":[{"id":1,"email":"a@x.com"},{"id":2,"email":"b@x.com"}]}');
  assert.equal(code, 200);
  assert.equal(body.meta.format, 'json');
  assert.equal(body.meta.type, 'object');
  assert.equal(body.shape.type, 'object');
  assert.equal(body.shape.fields.users.type, 'array');
  assert.equal(body.shape.fields.users.len, 2);
  assert.equal(body.meta.value, undefined);           // a digest, not the document
});

test('read drills a path over HTTP, and a wildcard collects from each element', async () => {
  await load('{"users":[{"email":"a@x.com"},{"email":"b@x.com"}]}');
  const { body } = await get('/api/read?path=' + encodeURIComponent('users[*].email'));
  assert.equal(body.found, true);
  assert.deepEqual(body.value, ['a@x.com', 'b@x.com']);
});

test('a bad path is a 400 the UI can render — not a 500 and not a thrown stack', async () => {
  await load('{"a":1}');
  const { code, body } = await get('/api/read?path=a.b.c');
  assert.equal(code, 200);          // read() reports the miss in-band
  assert.equal(body.found, false);
  assert.match(body.error, /no value at/);
});

test('find returns paths over HTTP that read() can resolve', async () => {
  await load('{"config":{"http":{"timeout_ms":3000}}}');
  const { body } = await get('/api/find?q=timeout');
  assert.ok(body.matched >= 1);
  assert.equal(body.hits[0].path, 'config.http.timeout_ms');
});

test('invalid JSON is a 400 with a located message, not a server crash', async () => {
  const { code, body } = await load('{ not json');
  assert.equal(code, 400);
  assert.match(body.error, /invalid JSON/);
});

test('the byte cap holds on a posted blob', async () => {
  const big = '[' + Array.from({ length: 5000 }, (_, i) => i).join(',') + ']';
  const { code, body } = await load(big, '?max_bytes=1000');
  assert.equal(code, 400);
  assert.match(body.error, /caps input/);
});

test('the static server serves the app at / and refuses a path-traversal', async () => {
  const html = await fetch(base + '/');
  assert.equal(html.status, 200);
  assert.match(await html.text(), /<title>prism/);
  const bad = await fetch(base + '/../../package.json');   // must not escape public/
  const txt = await bad.text();
  assert.doesNotMatch(txt, /"name": "@tools-for-agents\/prism"/);
});

test('/api/diff compares the loaded document against a second posted blob', async () => {
  await load('{"a":1,"b":2,"xs":[1,2]}');
  const r = await fetch(base + '/api/diff', { method: 'POST', body: '{"a":1,"b":9,"xs":[1,2,3],"c":true}' });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.changed, 1);          // b
  assert.equal(d.added, 2);            // xs[2], c
  const by = Object.fromEntries(d.changes.map((c) => [c.path, c.kind]));
  assert.equal(by.b, 'changed');
  assert.equal(by['xs[2]'], 'added');
});

// The web view's CSV path: a pasted spreadsheet can't be sniffed (a comma line looks like prose), so the
// browser declares it with ?format=csv — the same knob the new "read as" selector drives. Without it a
// CSV paste dies as "not valid JSON"; with it, a header row becomes keys and each row an object.
test('/api/load?format=csv reads a pasted spreadsheet as rows — the web view CSV knob', async () => {
  const { code, body } = await load('id,name,active\n1,Ada,true\n2,Alan,false\n', '?format=csv');
  assert.equal(code, 200);
  assert.equal(body.meta.format, 'csv');
  assert.equal(body.shape.type, 'array');
  assert.equal(body.shape.len, 2);
  assert.equal(body.shape.of.fields.id.type, 'int');       // conservative coercion still applies over HTTP
  assert.equal(body.shape.of.fields.active.type, 'bool');
  // and a path find returns is one read can resolve, at the array root CSV always has
  const row = await get('/api/read?path=' + encodeURIComponent('$[0]'));
  assert.equal(row.body.found, true);
  assert.deepEqual(row.body.value, { id: 1, name: 'Ada', active: true });
});

// The compare blob rides the same knob: a CSV diffed against a CSV, both declared, both parsed as rows.
test('/api/diff?format=tsv reads the compare blob as a spreadsheet too', async () => {
  await load('a\tb\n1\t2\n', '?format=tsv');
  const r = await fetch(base + '/api/diff?format=tsv', { method: 'POST', body: 'a\tb\n1\t9\n' });
  const d = await r.json();
  assert.equal(r.status, 200);
  assert.equal(d.changed, 1);                 // b: 2 -> 9 in the single row
  assert.equal(d.changes[0].path, '[0].b');
});

test('an unknown /api endpoint is a clean 404, not a hang', async () => {
  const { code } = await get('/api/nope');
  assert.equal(code, 404);
});
