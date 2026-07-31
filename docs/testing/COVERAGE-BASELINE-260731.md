# Coverage baseline — 2026-07-31

**The first honest coverage measurement in this repository's history.** Recorded here rather than
quoted in a chat, because a number nobody can reproduce is not a baseline.

## The number

Measured at `origin/main` `43557e1`:

```
Statements   : 55.69% ( 7973/14315 )
Branches     : 50.18% ( 6628/13208 )
Functions    : 52.01% ( 1122/2157 )
Lines        : 57.65% ( 7198/12485 )

191 test files / 1596 tests, exit 0
```

The proxy carried until now was `test-LoC / src-LoC = 48%`, always labelled as *a ratio, not
coverage*. The real statement figure is 55.69%. The proxy was a reasonable estimate — worth knowing
the next time one is offered in place of a measurement.

## No floor is set, deliberately

A threshold chosen at the moment of first measurement is a number invented to be met. Let a short
series accumulate, then set a floor against its shape. Setting 55% today would encode today's
accident as tomorrow's standard.

## The blocker that no longer exists

Since 2026-07-29 this was carried as blocked at a named upstream bug:

> `@vitest/coverage-istanbul` fails at instrumenter init — `TypeError: template is not a function`.
> `@babel/template@7.29.7` resolves to a namespace object rather than a callable under Vite's module
> runner. v8 is separately unsupported: `@cloudflare/vitest-pool-workers` rejects it by design
> because `node:inspector` is not functional in the Workers runtime.

The v8 half still holds. **The istanbul half does not** — a transitive dependency moved and the
provider now initialises cleanly. The lesson is not about Babel: a blocker recorded once and carried
forward as fact, never re-probed, is indistinguishable from a blocker that is still real.

## Reproduction

The real constraint was never the interop bug. A worktree's `node_modules` is normally a **symlink**
to the primary checkout, so installing a coverage provider there mutates the dependency tree of every
parallel session. Give the worktree a real install instead:

```bash
git worktree add -b cov-probe _wt/cov origin/main
cd _wt/cov && npm ci                                       # ~354 MB; needs a few GB free
npm i -D @vitest/coverage-istanbul@<match the vitest version>

npx vitest run src/workers/__tests__ \
  --exclude '**/*live*.test.ts' \
  --coverage.enabled --coverage.provider=istanbul \
  --coverage.reporter=text-summary \
  --coverage.include='src/workers/**/*.ts' \
  --coverage.exclude='**/__tests__/**'
```

Then remove the worktree. Nothing shared is touched.

### Two traps, both hit while producing this number

- `--coverage.include='src/workers/**'` **without** `/*.ts` sweeps in `README.md`, and istanbul dies
  parsing markdown as JavaScript.
- `--exclude '**/*-live-*'` misses `pilot-census-seed-live.test.ts`. Use `**/*live*.test.ts`.

### What is excluded, and why that is not a gap

The `*live*` suites require production or disposable DSNs and **correctly fail closed without them**
(exit 2, never 0). Including them measures nothing and fails the run; excluding them is the honest
scope, not a convenience.

Running the whole suite unbatched additionally fails 5 file loads — the 3 live suites plus 2 in the
nested `packages/xlooop-mcp-server`. **Zero tests fail; only file loads do.** That is precisely why
`ci-local` ships 49 bounded batches, and it is a property of the runner rather than of the code.

## What this number is not

It is not a quality verdict. This repository's own history is the argument: **1,577 green unit tests
coexisted with every customer-facing outage it has had.** The metric that actually predicted failures
here was *gates proven able to fail*, which is why that one carries a ratchet
(`verify:proven-red-ratchet`, floor 33) and this one does not.

Coverage is a map of what is exercised. It says nothing about whether the assertions are load-bearing.
