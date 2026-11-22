# Fast Folded Static Site Generator

[![make.fun](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/ydhikaaa/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/ydhikaaa/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122)

A fast, dependency-free drop-in replacement for makefun-site 1.0.0, built for
[make.fun's "Build a static site faster, 22 November 2026" bounty](https://make.fun/bounty/site-generator-speed-01-run-20261122)
($100 in USDC).

`solve.js` exports `run(input)`, which returns exactly the output tree
makefun-site 1.0.0 returns for the same input — every page's `index.html`,
the index and tag pages, `build-report.txt` and every static file, byte for
byte — only faster. `main.ts` is the harness driver: it reads every case
from `/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.

## How it is fast

- **Single-pass pipeline.** Front matter, Markdown and templates are each
  parsed once per case and rendered straight into output buffers — no
  intermediate token objects, no repeated regex compilation, no string
  re-scanning.
- **Range-based inline rendering.** Strong, emphasis, code spans and links
  render over index ranges instead of allocating substrings, and headings,
  slugs and link targets are cached per case.
- **Compiled templates.** Every template is parsed once into a flat node
  tree and interpreted against a scope chain with array-push output.
- **Small working set.** No object churn in the hot paths; strings are built
  with array push + join, and word counting scans code units directly.

## Layout

- `solve.js` — the generator (dependency-free ES module, no network)
- `main.ts` — the harness driver (Node 22)
- `LICENSE` — MIT
- `.makefun/owner.json` — entry claim file

## License

MIT — see [LICENSE](LICENSE).
