# mend — one patch tool for every AI edit format

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/people871/makefun-hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/people871/makefun-hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

`mend` applies a patch to a working directory, in any of the four formats AI tools emit: unified diffs, `<<<<<<< SEARCH` / `=======` / `>>>>>>> REPLACE` blocks, V4A (`*** Begin Patch`), and JSON / JSON Lines edits. Written from scratch in a single `main.ts` (Node 22 stdlib only, no dependencies, no network).

## The numbers

- **Practice set: 100/100 checks, score 1000** on all three practice trials (unified 30, search_replace 20, v4a 20, json 15, cli 15, working 1) — verified with the kit's `grade-local`, replay matched byte-for-byte.
- **House bar: 750** — a strict applier (exact line matching only, tier 0) scores 75/100 on the same practice set. `mend` beats it by 250 points.
- **114/114 extra edge tests pass** (usage errors, `--check`, `--strict`, CRLF / trailing-break rules, all-or-nothing, moves, unsafe paths, ambiguous matches, parse-error line numbers, stdin).
- **Deterministic**: two `grade-local` runs and two practice runs produce byte-identical trial state hashes and action logs.
- **Repo ~50 KB** (limit 4 MiB; every file under 1 MiB).

## How it works

1. **Detect.** The patch format is auto-detected (or forced with `--format=`): `*** Begin Patch` → V4A, `[`/`{` → JSON, `<<<<<<< SEARCH` → search/replace, `diff --git ` or a `--- `+`+++ ` pair → unified diff. The whole patch is parsed before any file is touched; a parse error aborts with `error: parse <N>` and nothing is written.
2. **Match in three tiers.** Context lines match a file's lines at tier 0 (exact), tier 1 (trailing whitespace ignored), or tier 2 (leading and trailing whitespace ignored, spaces/tabs only). The first tier with an occurrence wins; unified diffs take the occurrence nearest the hunk's stated position, V4A anchors search forward from a cursor, and search/replace and JSON `str_replace` require exactly one occurrence (`ambiguous` / `no-match` otherwise). Tier-2 matches re-indent the new lines to the file's own indentation — including prepending it when the patch line had none.
3. **Apply atomically.** Each edit is checked (unsafe path, missing file, file already exists) before it runs, and a failed edit rolls back its own changes while later edits still run. On success, changed files are written all at once; output lists `A`/`D`/`M` lines in path order, with `R <old> -> <new>` for a qualifying delete-plus-add pair, then `ok: <n> files`.
4. **Line breaks are preserved.** A file's break is CRLF iff its first newline follows a `\r`; changed files keep their own break and trailing-break state, and `\ No newline at end of file` rules are honored exactly.

## Run it

```sh
node main.ts [--check] [--strict] [--format=unified|search_replace|v4a|json] [PATCH]
```

`PATCH` is a path, or `-` / omitted to read from stdin. Exit 0 on success, 1 for a failed edit (`error: <code> <path>` per failure plus `failed: <k> of <n> edits`), 2 for usage / no-patch / format / parse errors. `--check` prints the same output and exit code without writing anything; `--strict` allows tier-0 matches only.
