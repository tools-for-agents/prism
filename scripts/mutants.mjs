// CAN THE TEST SUITE STILL FAIL?
//
// Every other gate here asks "is the code right". This one asks the question underneath it:
// IS ANYTHING STILL WATCHING. A suite that has quietly stopped covering a property goes green
// for exactly the same reason as a suite that is passing honestly, and there is no way to tell
// the two apart by looking at the green.
//
// It has happened across this kit more than once. anvil's Docker tests were SKIPPED for months
// — 11 pass, 0 fail, 9 skipped, green every run — while the tool was completely broken on Linux.
// prism's own build already lost a canary the hard way: a spread `undefined` clobbered a default
// and prism_find returned ZERO hits over MCP, and only the stdio suite caught it.
//
// So: break the code ON PURPOSE, in the exact places whose breakage would cost the most, and
// demand the suite goes RED. If it stays green, the canary is dead and this job fails — the test
// guarding that line has stopped guarding it, and you find out today rather than the morning after.
//
//   node scripts/mutants.mjs
//
// Each canary must have EXACTLY ONE anchor. An anchor that has drifted is a canary that silently
// stopped watching, so a missing or ambiguous anchor is a hard failure, never a skip.

import { readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const CANARIES = [
  {
    why: 'int and float are different facts — an agent shaping an id column vs a price needs to know which; collapse them and every integer reads as a float',
    file: 'src/core.js',
    find: "return Number.isInteger(v) ? 'int' : 'float';",
    into: "return 'float';",
  },
  {
    why: 'shape must STOP at maxDepth — remove the object depth cap and a deeply nested blob recurses without bound instead of truncating (the whole point of a shape is that it stays small)',
    file: 'src/core.js',
    find: "if (depth >= o.maxDepth) return { type: 'object', keys: keys.length, truncated: true };",
    into: "if (false) return { type: 'object', keys: keys.length, truncated: true };",
  },
  {
    why: 'a 10k-key object must show maxKeys and COUNT the rest (withheld) — dump every key and the shape IS the blob',
    file: 'src/core.js',
    find: 'const shown = keys.slice(0, o.maxKeys);',
    into: 'const shown = keys;',
  },
  {
    why: 'an over-budget read must hand back the SHAPE and the honest size, never the full value as if it fit — a silently complete oversized value is the confident wrong answer',
    file: 'src/core.js',
    find: 'if (tokens <= o.budget) return { ...base, complete: true, value: sub };',
    into: 'if (true) return { ...base, complete: true, value: sub };',
  },
  {
    why: 'a value too deep for JSON.stringify must return its shape — skip the guard and read hands back a raw value the CLI/MCP then re-serialises and stack-overflows on',
    file: 'src/core.js',
    find: '  if (json == null) {',
    into: '  if (false) {',
  },
  {
    why: 'numbers/bools match EXACTLY, or a search for "1" also matches 1000 and 21 — a value filter that over-matches is worse than none',
    file: 'src/core.js',
    find: '  return String(v).toLowerCase() === qLower; // numbers/bools: exact, so "1" doesn\'t match "1000"',
    into: '  return String(v).toLowerCase().includes(qLower); // numbers/bools: exact, so "1" doesn\'t match "1000"',
  },
  {
    why: 'find must STOP after maxNodes and say so — an unbounded walk over a huge document is the DoS the whole tool is built to avoid',
    file: 'src/core.js',
    find: 'if (visited++ >= o.maxNodes) { truncated = true; break; }',
    into: 'if (false) { truncated = true; break; }',
  },
  {
    why: 'find caps the hits it RETURNS and reports how many it withheld — remove the cap and a 10-hit request floods back 300',
    file: 'src/core.js',
    find: "if (hits.length < o.maxHits) hits.push({ path, kind: 'key', type: kindOf(v), preview: previewOf(v) });",
    into: "hits.push({ path, kind: 'key', type: kindOf(v), preview: previewOf(v) });",
  },
  {
    why: '`[*]` collects the tail path from each element — skip the push and every wildcard read returns an empty list',
    file: 'src/core.js',
    find: 'if (r.ok) out.push(r.value); // elements that don\'t have the tail are simply skipped',
    into: 'if (false) out.push(r.value); // elements that don\'t have the tail are simply skipped',
  },
  {
    why: 'a slice CLAMPS a positive bound to the array — drop the Math.min and users[0:100] on a short array walks off the end, gathering an undefined for every index that never existed',
    file: 'src/core.js',
    find: 'const norm = (x, dflt) => x == null ? dflt : (x < 0 ? Math.max(0, n + x) : Math.min(x, n));',
    into: 'const norm = (x, dflt) => x == null ? dflt : (x < 0 ? Math.max(0, n + x) : x);',
  },
  {
    why: 'a negative index counts FROM THE END — skip the conversion and logs[-1] is treated as literal index -1, which is always out of range, so "the last element" can never be read',
    file: 'src/core.js',
    find: 'const idx = a.index < 0 ? value.length + a.index : a.index;',
    into: 'const idx = a.index;',
  },
  {
    why: 'an empty query is REFUSED, not run — otherwise it "matches" every string in the document and calls a mistake a result',
    file: 'src/core.js',
    find: "if (!q) return { query: String(query ?? ''), hits: [], matched: 0, error: 'empty query' };",
    into: "if (false) return { query: String(query ?? ''), hits: [], matched: 0, error: 'empty query' };",
  },
  {
    why: 'diff must NAME an added key as added — miss the "only in b" case and a new field is mislabelled a change of something that was not there',
    file: 'src/core.js',
    find: "if (!(key in a)) record('added', p, undefined, b[key]);",
    into: "if (false) record('added', p, undefined, b[key]);",
  },
  {
    why: 'diff compares arrays by index — an element present only in the LONGER array is an addition at that position, not a change',
    file: 'src/core.js',
    find: 'if (i >= a.length) record(\'added\', p, undefined, b[i]);',
    into: 'if (false) record(\'added\', p, undefined, b[i]);',
  },
  {
    why: 'diff caps the changes it RETURNS while keeping the summary counts complete — remove the cap and two very different blobs flood back thousands of rows',
    file: 'src/core.js',
    find: 'if (changes.length < o.maxHits) {',
    into: 'if (true) {',
  },
  {
    why: 'diff must STOP after maxNodes — an unbounded walk over two adversarial blobs is a DoS just like an unbounded find',
    file: 'src/core.js',
    find: 'if (visited++ >= o.maxNodes) { truncated = true; return; }',
    into: 'if (false) { truncated = true; return; }',
  },
  {
    why: 'an oversized file is refused BEFORE it is read — skip the size check and a 2 GB file is read into memory and freezes the process (JSON.parse is all-or-nothing)',
    file: 'src/load.js',
    find: 'if (st.size > cap) {',
    into: 'if (false) {',
  },
  {
    why: 'empty input is named as empty, not passed on — skip it and the caller gets a confusing "invalid JSON" for a blank paste',
    file: 'src/load.js',
    find: "if (!trimmed) throw new PrismError('the input is empty — nothing to read');",
    into: "if (false) throw new PrismError('the input is empty — nothing to read');",
  },
  {
    why: 'CSV coercion must ROUND-TRIP or stay a string — drop the String(n)===s check and "007" becomes 7 (leading zeros lost), "1.0" becomes 1 (a version turned into a number)',
    file: 'src/load.js',
    find: 'if (Number.isFinite(n) && String(n) === s) return n;',
    into: 'if (Number.isFinite(n)) return n;',
  },
  {
    why: 'csv/tsv is chosen, never auto-detected — skip the routing and a spreadsheet is fed to JSON.parse and errors',
    file: 'src/load.js',
    find: "if (forced === 'csv' || forced === 'tsv') {",
    into: 'if (false) {',
  },
  {
    why: 'a path find returns must be one read can resolve — at an ARRAY root the index is `[i]`, not `$[i]` (which read parses as a bogus $ key). It only bites array-root data, which CSV always is',
    file: 'src/core.js',
    find: 'path: path === \'$\' ? `[${i}]` : `${path}[${i}]`, key: null });',
    into: 'path: path === \'#\' ? `[${i}]` : `${path}[${i}]`, key: null });',
  },
];

// spawnSync returns status:null when IT kills the child for exceeding the timeout — a TIMEOUT, not a
// test failure. Distinguish them: a suite that never finished has not answered, and a mutant that
// makes the suite hang has not been "killed".
const TIMEOUT_MS = 600_000;
const run = () => {
  const r = spawnSync('npm', ['test'], { encoding: 'utf8', timeout: TIMEOUT_MS });
  const skipped = +(`${r.stdout || ''}${r.stderr || ''}`.match(/^\s*(?:ℹ|#)\s*skipped\s+(\d+)/m)?.[1] || 0);
  return { failed: r.status !== 0, timedOut: r.signal === 'SIGTERM' || r.error?.code === 'ETIMEDOUT', skipped };
};

// 🔑 AND IT MUST NOT RUN TWICE AT ONCE. This tool EDITS YOUR SOURCE IN PLACE, so two concurrent runs
// can make a planted bug PERMANENT: run A reads core.js as its "original" while run B's mutation is on
// disk, then A restores that poisoned baseline. An exclusive lock, taken BEFORE the baseline.
const LOCK = new URL('../.mutants.lock', import.meta.url);
try {
  writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
} catch {
  let holder = '?';
  try { holder = readFileSync(LOCK, 'utf8').trim(); } catch { /* raced with a clean exit */ }
  const alive = holder !== '?' && (() => { try { process.kill(+holder, 0); return true; } catch { return false; } })();
  if (alive) {
    console.error(`another mutants run (pid ${holder}) is already editing this source tree. `
      + 'Two at once can make a planted bug PERMANENT. Wait for it, or kill it.');
    process.exit(1);
  }
  writeFileSync(LOCK, String(process.pid));
}
const dropLock = () => { try { unlinkSync(LOCK); } catch {} };
process.on('exit', dropLock);

// The baseline must be GREEN, or every canary "dies" for free and this job proves nothing.
console.log('baseline…');
const base = run();
if (base.timedOut) {
  console.error(`THE SUITE DID NOT FINISH within ${TIMEOUT_MS / 1000}s — a timeout, not a failure.`);
  process.exit(1);
}
if (base.failed) { console.error('THE SUITE IS ALREADY RED. Nothing can be proven from here.'); process.exit(1); }
if (base.skipped) {
  console.log(`⚠ the baseline SKIPPED ${base.skipped} test(s) — those cannot kill a canary. A survivor below `
    + 'is more likely a missing dependency than a missing test.');
}
console.log('baseline: green\n');

// 🔑 THE MUTATION IS WRITTEN INTO YOUR SOURCE FILE and undone once the suite has run. If this process
// dies in between, the planted bug is LEFT IN YOUR TREE. A tool that plants bugs on purpose must be the
// one thing that ALWAYS cleans up after itself. writeFileSync is synchronous, so it is safe in exit.
let planted = null;
const restore = () => { if (planted) { writeFileSync(planted.file, planted.orig); planted = null; } };
process.on('exit', restore);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'])
  process.on(sig, () => { restore(); process.exit(130); });
process.on('uncaughtException', (e) => { restore(); console.error(e); process.exit(1); });

let dead = 0;
for (const c of CANARIES) {
  const orig = readFileSync(c.file, 'utf8');
  const hits = orig.split(c.find).length - 1;
  if (hits !== 1) {
    console.error(`✗ ANCHOR DRIFTED in ${c.file}: found ${hits}×\n    ${c.find}\n  ` +
      'A canary whose anchor has moved is not watching anything. Re-point it.');
    dead++; continue;
  }
  planted = { file: c.file, orig };
  writeFileSync(c.file, orig.replace(c.find, c.into));
  const res = run();
  restore();

  if (res.timedOut) {
    console.error(`✗ INCONCLUSIVE — the suite timed out with this broken, so we cannot say it was killed:\n    ${c.why}`);
    dead++;
  } else if (!res.failed) {
    console.error(`✗ SURVIVED — the suite went GREEN with this broken:\n    ${c.why}\n    ${c.file}`);
    console.error(res.skipped
      ? `  …but ${res.skipped} test(s) were SKIPPED — most likely a MISSING DEPENDENCY, not a missing test.`
      : '  Nothing is guarding that line any more.');
    dead++;
  } else {
    console.log(`✓ killed — ${c.why}`);
  }
}

if (dead) { console.error(`\n${dead} canary/canaries are not watching. The suite cannot prove what it claims.`); process.exit(1); }
console.log(`\nall ${CANARIES.length} canaries killed — the suite can still fail where it matters.`);
