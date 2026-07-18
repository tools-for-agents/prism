// prism CSV tests — the zero-dep RFC 4180 parser and its format detection. The contract: the header
// names the columns, quoted fields carry the delimiter/newlines/escaped-quotes intact, and coercion
// is conservative (a number only when it round-trips exactly, so nothing is silently lost). Once it
// is an array of row objects, shape/read/find/diff already work on it — proven at the end.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCsv, parseData, formatFromName } from '../src/load.js';
import { shape, find, read } from '../src/core.js';

test('the header row names the columns; each later row is an object', () => {
  const rows = parseCsv('id,name\n1,Ada\n2,Grace\n');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows[0], { id: 1, name: 'Ada' });
  assert.deepEqual(rows[1], { id: 2, name: 'Grace' });
});

test('a quoted field carries the delimiter, a newline, and an escaped quote intact', () => {
  const rows = parseCsv('a,b\n"x, y","line1\nline2",\n"he said ""hi""",z\n');
  assert.equal(rows[0].a, 'x, y');              // embedded comma
  assert.equal(rows[0].b, 'line1\nline2');      // embedded newline
  assert.equal(rows[1].a, 'he said "hi"');      // escaped quote ""
});

test('coercion is conservative — it round-trips or it stays a string', () => {
  const rows = parseCsv('int,float,bool,zeros,exp,ver,inf\n7,1.5,true,007,1e3,1.0,Infinity\n');
  const r = rows[0];
  assert.equal(r.int, 7);
  assert.equal(r.float, 1.5);
  assert.equal(r.bool, true);
  assert.equal(r.zeros, '007');    // String(7) !== "007" → not coerced (would lose the leading zeros)
  assert.equal(r.exp, '1e3');      // String(1000) !== "1e3"
  assert.equal(r.ver, '1.0');      // String(1) !== "1.0" — a version, not the number 1
  assert.equal(r.inf, 'Infinity'); // not finite → stays a string (JSON can't hold it anyway)
});

test('empty cells stay empty strings, and a blank line is skipped (not a row of one empty field)', () => {
  const rows = parseCsv('a,b,c\n1,,3\n\n4,5,6\n');
  assert.equal(rows.length, 2);          // the blank line did not become a row
  assert.equal(rows[0].b, '');           // the empty middle cell is an empty string
  assert.deepEqual(rows[1], { a: 4, b: 5, c: 6 });
});

test('a final row with no trailing newline is not dropped', () => {
  const rows = parseCsv('a,b\n1,2');
  assert.deepEqual(rows, [{ a: 1, b: 2 }]);
});

test('TSV uses the tab delimiter', () => {
  const rows = parseCsv('a\tb\n1\thello world\n', { delimiter: '\t' });
  assert.deepEqual(rows[0], { a: 1, b: 'hello world' });
});

test('parseData routes csv/tsv by the forced format, and never auto-detects CSV', () => {
  const { value, format } = parseData('x,y\n1,2\n', { format: 'csv' });
  assert.equal(format, 'csv');
  assert.deepEqual(value, [{ x: 1, y: 2 }]);
  // without a format, "x,y" is NOT valid JSON and must NOT be silently read as CSV — it errors
  assert.throws(() => parseData('x,y\n1,2\n'), /invalid JSON|not valid JSON/);
});

test('formatFromName reads the extension, incl. a URL query, and leaves .json to auto-detect', () => {
  assert.equal(formatFromName('data.csv'), 'csv');
  assert.equal(formatFromName('/path/to/report.TSV'), 'tsv');
  assert.equal(formatFromName('https://x.com/export.csv?v=2'), 'csv');
  assert.equal(formatFromName('logs.ndjson'), 'jsonl');
  assert.equal(formatFromName('data.jsonl'), 'jsonl');
  assert.equal(formatFromName('data.json'), undefined);   // auto-detect handles JSON
  assert.equal(formatFromName('nofile'), undefined);
});

test('once parsed, the four verbs work on a CSV exactly as on JSON', () => {
  const { value } = parseData('id,email\n1,a@x\n2,b@x\n', { format: 'csv' });
  const s = shape(value);
  assert.equal(s.type, 'array');
  assert.equal(s.of.fields.email.type, 'string');
  assert.equal(read(value, '[1].email').value, 'b@x');
  assert.equal(find(value, 'b@x').hits[0].path, '[1].email');
});
