# AGENTS.md — prism

🔻 **The agent's data reader.** Any JSON/JSONL blob becomes its shape and the slice you asked for, not the
whole thing. What scout does for the web and lens does for code, prism does for structured data. CLI + MCP.
Part of [tools-for-agents](https://github.com/tools-for-agents).

## Setup

```bash
node --version                                   # 22+ required. Nothing to install.
npm test                                         # = node --test
echo '{"a":{"b":[1,2,3]}}' | node src/cli.js shape -
node src/cli.js read data.json --path 'items[*].id'
node src/cli.js find config.json "timeout"
npm run mcp                                       # the MCP server, stdio
```

**Zero runtime dependencies, and that is a hard rule.** No `dependencies` in `package.json`, ever. Node 22+
gives you `fetch`, a test runner, and everything else this needs. If a feature seems to *need* a library,
the feature is too big — ship the smaller version.

## The three verbs

- `shape <src>` — the skeleton: keys→types, array lengths, nesting.
- `read <src> --path P` — the subtree at path `P`, token-budgeted.
- `find <src> "<query>"` — the **paths** where a key/value lives (the input to `read`).

`<src>` is a file, an `http(s)` URL, or `-` (stdin). Paths: `data.items[0].name`, `users[*].id`, `$`.

## The rules this repo is built on

**1. It reads UNTRUSTED data, so every operation is BOUNDED.** This is the whole identity of the tool. Input
is byte-capped *before* `JSON.parse` (all-or-nothing; a 2 GB file is a frozen process). `shape` is depth- and
key-bounded. `read` is token-budgeted. `find` is node-bounded. Any new feature that traverses or allocates
must carry its own ceiling — grep the DoS lesson the kit already paid for (anvil's 40 GB diff).

**2. A clipped answer must carry the size of the whole.** "20 results" and "20 of 1284 results" are
different facts. `shape` reports the true `keys`/`len` even when it only shows some; an over-budget `read`
returns the *shape* and `withheld_tokens`, never a truncated body that looks complete; `find` reports
`withheld` and `truncated`. Copy this contract into anything new — it is scout's and lens's too.

**3. A wrong path is a FACT, not an exception.** `read` on a missing key returns `{found:false, error:"no
value at data.nope — …"}` naming where the walk fell off and the type actually there. Never throw a bare
"cannot read property of undefined" at the caller; that is the confident wrong answer in its purest form.

**4. int ≠ float, null ≠ missing.** An agent shaping an id column vs a price column needs to know which is
which; a key that is present-and-null is a different fact from a key that is absent. `kindOf` keeps them
distinct and `shape` marks a partial key `optional`. Don't collapse them.

**5. Match V8's moving target on parse errors.** Node's `JSON.parse` message format drifts between versions
(`position N`, `(line N column N)`, or neither for short inputs). `parseError` handles all three and falls
back to the raw message rather than inventing a location. If you touch it, test on the installed Node.

## Tests

`npm test` — `node --test`, **no test may be skipped** (CI fails on a skip). Prefer a test that fails against
the original code: every bound is proven by building an input that overruns it. The MCP suite drives the real
server over stdio — a bug that only appears through the protocol layer (like a spread `undefined` clobbering
a default and returning zero hits) is caught there, not in the core.

## CI

`test` — and none of its tests may be skipped.

*(No web view yet — when one lands, it gets [iris](https://github.com/tools-for-agents/iris) `look` gates
like the rest of the kit, plus a `mutants` gate over `src/core.js`.)*
