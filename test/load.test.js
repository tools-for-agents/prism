// prism load tests — parsing and the byte cap that is prism's DoS defence. The cap is the point of
// the tool: a value that cannot be read without buffering more than the ceiling is refused, not
// swallowed. These prove the refusal happens and that a syntax error is reported with a location.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readSource, parseData, PrismError, human } from '../src/load.js';

const work = mkdtempSync(join(tmpdir(), 'prism-'));
process.on('exit', () => { try { rmSync(work, { recursive: true, force: true }); } catch {} });
const write = (name, s) => { const p = join(work, name); writeFileSync(p, s); return p; };

test('parseData reads plain JSON', () => {
  const { value, format } = parseData('{"a":1,"b":[2,3]}');
  assert.deepEqual(value, { a: 1, b: [2, 3] });
  assert.equal(format, 'json');
});

test('parseData reads JSONL / NDJSON as an array of the per-line values', () => {
  const { value, format } = parseData('{"id":1}\n{"id":2}\n{"id":3}\n');
  assert.equal(format, 'jsonl');
  assert.deepEqual(value.map((r) => r.id), [1, 2, 3]);
});

test('a JSON syntax error is reported with a line and column, not a bare "Unexpected token"', () => {
  assert.throws(() => parseData('{\n  "a": 1,\n  "b": 2,\n  bad: 3\n}', { format: 'json' }), (e) => {
    assert.ok(e instanceof PrismError);
    assert.match(e.message, /line 4, column \d+/);
    return true;
  });
});

test('empty input is refused with a clear message, not a null value', () => {
  assert.throws(() => parseData('   \n  '), /empty/);
});

test('a malformed JSONL line names WHICH line failed', () => {
  assert.throws(() => parseData('{"ok":1}\nnot json\n{"ok":3}', { format: 'jsonl' }), /line 2/);
});

test('readSource refuses a file larger than the byte cap BEFORE reading it', async () => {
  const p = write('big.json', '['.padEnd(5000, ' ') + ']');
  await assert.rejects(readSource(p, { maxBytes: 1000 }), (e) => {
    assert.ok(e instanceof PrismError);
    assert.match(e.message, /caps input at|1000|1\.0 KB/);
    return true;
  });
});

test('readSource reads a normal file and reports its byte size and source', async () => {
  const p = write('ok.json', '{"hello":"world"}');
  const { text, bytes, source } = await readSource(p, {});
  assert.equal(text, '{"hello":"world"}');
  assert.equal(bytes, 17);
  assert.equal(source, p);
});

test('readSource on a missing file gives a clean "no such file", not a stack trace', async () => {
  await assert.rejects(readSource(join(work, 'nope.json'), {}), (e) => {
    assert.ok(e instanceof PrismError);
    assert.match(e.message, /no such file/);
    return true;
  });
});

test('human() renders byte sizes an agent can read', () => {
  assert.equal(human(512), '512 B');
  assert.equal(human(1536), '1.5 KB');
  assert.equal(human(64 * 1024 * 1024), '64 MB');
});
