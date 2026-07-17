// prism source loading — turn a file / URL / stdin into a parsed value, WITHOUT ever holding more
// than the byte cap in memory. This is the front door to untrusted data, so it is where the DoS
// defence lives: the cap is enforced BEFORE JSON.parse, because JSON.parse is all-or-nothing and a
// 2 GB file handed to it is a 2 GB allocation and a frozen process.
import { readFileSync, statSync } from 'node:fs';
import { DEFAULTS } from './core.js';

// Read a source to a string, capped. Returns { text, bytes, source }.
export async function readSource(src, opts = {}) {
  const cap = opts.maxBytes ?? DEFAULTS.maxBytes;
  if (src === '-' || src == null) return { ...(await readStdin(cap)), source: 'stdin' };
  if (/^https?:\/\//i.test(src)) return { ...(await readUrl(src, cap)), source: src };
  return { ...readFile(src, cap), source: src };
}

function readFile(path, cap) {
  let st;
  try { st = statSync(path); }
  catch (e) { throw new PrismError(`cannot read ${path}: ${e.code === 'ENOENT' ? 'no such file' : e.message}`); }
  if (st.isDirectory()) throw new PrismError(`${path} is a directory, not a data file`);
  // Refuse an oversized file up front — do NOT read it to find out it was too big.
  if (st.size > cap) {
    throw new PrismError(`${path} is ${human(st.size)}; prism caps input at ${human(cap)}. `
      + `Pipe a slice (e.g. head -c ${cap} ${path} | prism …) or raise --max-bytes.`);
  }
  const text = readFileSync(path, 'utf8');
  return { text, bytes: Buffer.byteLength(text) };
}

async function readUrl(url, cap) {
  let res;
  try { res = await fetch(url, { redirect: 'follow' }); }
  catch (e) { throw new PrismError(`fetch failed for ${url}: ${e.message}`); }
  if (!res.ok) throw new PrismError(`fetch returned ${res.status} ${res.statusText} for ${url}`);
  // Trust Content-Length only as a fast reject; the real cap is enforced while streaming, because a
  // server can lie or omit the header.
  const declared = +res.headers.get('content-length');
  if (declared && declared > cap) {
    throw new PrismError(`${url} declares ${human(declared)}; prism caps input at ${human(cap)}. Raise --max-bytes if you mean it.`);
  }
  const reader = res.body?.getReader();
  if (!reader) { const text = await res.text(); return capText(text, cap, url); }
  const chunks = []; let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > cap) { try { await reader.cancel(); } catch {} throw overCap(url, cap); }
    chunks.push(value);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), bytes: total };
}

function readStdin(cap) {
  return new Promise((resolve, reject) => {
    const chunks = []; let total = 0;
    process.stdin.on('data', (c) => {
      total += c.length;
      if (total > cap) {
        process.stdin.destroy();
        reject(overCap('stdin', cap));
        return;
      }
      chunks.push(c);
    });
    process.stdin.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), bytes: total }));
    process.stdin.on('error', (e) => reject(new PrismError(`reading stdin: ${e.message}`)));
  });
}

function capText(text, cap, where) {
  if (Buffer.byteLength(text) > cap) throw overCap(where, cap);
  return { text, bytes: Buffer.byteLength(text) };
}

// Parse the loaded text as JSON, or as JSONL/NDJSON (one JSON value per line) when whole-file parse
// fails but every non-empty line is valid on its own. A genuine syntax error is reported with the
// line/offset, never a bare "Unexpected token".
export function parseData(text, opts = {}) {
  const trimmed = text.trim();
  if (!trimmed) throw new PrismError('the input is empty — nothing to read');
  const forced = opts.format;
  if (forced !== 'jsonl') {
    try { return { value: JSON.parse(text), format: 'json' }; }
    catch (jsonErr) {
      if (forced === 'json') throw parseError(text, jsonErr);
      // fall through and try JSONL only if it plausibly is line-delimited
    }
  }
  const lines = text.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => l.trim());
  if (lines.length > 1 || forced === 'jsonl') {
    const rows = [];
    for (const [n, l] of lines) {
      try { rows.push(JSON.parse(l)); }
      catch (e) { throw new PrismError(`line ${n} is not valid JSON (and the whole input is not one JSON value either): ${e.message}`); }
    }
    return { value: rows, format: 'jsonl' };
  }
  // single line that failed JSON — report that failure properly
  throw parseError(text, safeParse(text));
}

function safeParse(t) { try { JSON.parse(t); } catch (e) { return e; } return null; }

// Turn whatever V8 gives into a line:col the agent can navigate to. Node's JSON error message has
// drifted between versions: sometimes "(line N column N)", sometimes "at position N", sometimes
// (for short inputs) neither. Handle all three, and fall back to the raw message — which still names
// the offending token — rather than inventing a location.
function parseError(text, err) {
  const msg = err?.message || 'parse failed';
  const lc = /line (\d+) column (\d+)/.exec(msg);
  if (lc) return new PrismError(`invalid JSON at line ${lc[1]}, column ${lc[2]}: ${msg}`);
  const pm = /position (\d+)/.exec(msg);
  const pos = pm ? +pm[1] : (/Unexpected end/i.test(msg) ? text.length : null);
  if (pos == null) return new PrismError(`invalid JSON: ${msg}`);
  const before = text.slice(0, pos);
  const line = before.split('\n').length;
  const col = pos - before.lastIndexOf('\n');
  return new PrismError(`invalid JSON at line ${line}, column ${col}: ${msg}`);
}

function overCap(where, cap) {
  return new PrismError(`input from ${where} exceeded the ${human(cap)} cap — prism will not buffer more. Slice it upstream or raise --max-bytes.`);
}

export class PrismError extends Error {}

export function human(n) {
  if (n < 1024) return `${n} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let i = -1; do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
  return `${n.toFixed(n < 10 ? 1 : 0)} ${u[i]}`;
}
