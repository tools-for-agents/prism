#!/usr/bin/env node
// prism CLI — read structured data from the shell.
//   prism shape <file|url|->            the skeleton: keys→types, array lengths, nesting
//   prism read  <file|url|-> --path P   the subtree at path P, token-budgeted
//   prism find  <file|url|-> "<query>"  where a key/value lives → the paths to read
// Flags: --path <p> · --tokens <n> (read budget) · --max-bytes <n> · --depth <n> · --keys <n>
//        --format json|jsonl · -k/--limit <n> (find hits) · --raw (print value only, no envelope)
import { shape, read, find } from './core.js';
import { readSource, parseData, PrismError, human } from './load.js';

const [, , cmd, ...rest] = process.argv;
const VALUE = new Set(['--path', '--tokens', '--max-bytes', '--depth', '--keys', '--format', '-k', '--limit']);
const positionals = []; const flags = {};
for (let i = 0; i < rest.length; i++) {
  const a = rest[i];
  if (a === '-' || !a.startsWith('-')) positionals.push(a);
  else if (VALUE.has(a)) flags[a] = rest[++i];
  else flags[a] = true;
}
const flag = (n, d) => (flags[n] !== undefined ? flags[n] : d);
const has = (n) => flags[n] === true;
const out = (o) => console.log(typeof o === 'string' ? o : JSON.stringify(o, null, 2));

const num = (v) => (v == null ? undefined : Math.floor(+v));
function opts() {
  const o = {};
  if (flags['--max-bytes'] != null) o.maxBytes = num(flags['--max-bytes']);
  if (flags['--depth'] != null) o.maxDepth = num(flags['--depth']);
  if (flags['--keys'] != null) o.maxKeys = num(flags['--keys']);
  if (flags['--tokens'] != null) o.budget = num(flags['--tokens']);
  if (flags['-k'] != null || flags['--limit'] != null) o.maxHits = num(flag('-k', flag('--limit')));
  if (flags['--format']) o.format = flags['--format'];
  return o;
}

const HELP = `prism — read structured data the way an agent needs it: the shape and the slice, not the blob.

  prism shape <file|url|->            the skeleton: keys→types, array lengths, nesting
  prism read  <file|url|-> --path P   the subtree at path P (token-budgeted; over budget → its shape)
  prism find  <file|url|-> "<query>"  where a key or value lives → the paths to read

  paths:  data.items[0].name   ·   users[*].id   ·   $ (the root)
  flags:  --path P  --tokens N (read budget)  --depth N  --keys N  --max-bytes N
          --format json|jsonl  -k N (find hits)  --raw (value only)

  echo '{"a":{"b":[1,2,3]}}' | prism shape -
  prism read api.json --path data.users[*].email
  prism find config.json "timeout"`;

try {
  if (!cmd || cmd === 'help' || cmd === '--help' || cmd === '-h') { out(HELP); process.exit(0); }

  const src = positionals[0] ?? '-';
  const o = opts();
  const { text, bytes, source } = await readSource(src, o);
  const { value, format } = parseData(text, o);

  if (cmd === 'shape') {
    const sh = shape(value, o);
    if (has('--raw')) { out(sh); }
    else {
      out(`▸ ${source} · ${human(bytes)} · ${format}`);
      out(sh);
    }
  } else if (cmd === 'read') {
    const path = flag('--path', positionals[1] ?? '$');
    const r = read(value, path, o);
    if (has('--raw')) { out(r.found ? (r.complete ? r.value : r.shape) : `error: ${r.error}`); }
    else out(r);
  } else if (cmd === 'find') {
    const query = positionals[1] ?? flag('--path', '');
    out(find(value, query, o));
  } else {
    console.error(`prism: unknown command "${cmd}"\n`);
    out(HELP);
    process.exit(2);
  }
} catch (e) {
  if (e instanceof PrismError) { console.error(`prism: ${e.message}`); process.exit(1); }
  throw e;
}
