# sessionr — Agent-Readiness Audit (v2.5.4)

Run by the `optimize-agentic-cli` skill at `2026-05-15`. Target binary: `dist/cli.js` built from the `main` branch (commit `8c1660c`).

The audit covers the five core checks the skill mandates plus extended dimensions (iterative loops, write-path, cwd-awareness). Findings are file-per-issue under `agentic-issues/<context>/NN-<severity>-<slug>.md`. Raw probe output is in `agentic-issues/_probes/`.

Severity uses agent-impact terms (skill rubric):
- **Critical** — agents cannot safely parse, continue, or avoid unintended side effects.
- **High** — agents act but are likely to fail, retry incorrectly, or block.
- **Medium** — agents finish only with extra probing or brittle assumptions.
- **Low** — polish or consistency only.

---

## Scorecard against the five core checks

| # | Skill check | Status | Notes |
|---|---|---|---|
| 1 | `--output json/jsonl` exists, stdout is **pure** machine output | ⚠️ partial | json/jsonl exist, but `list --output jsonl` returns one giant JSON ([[output-contracts/01-CRITICAL-list-jsonl-is-not-jsonl]]); `--output table` and unknown `--output xml` are silently aliased ([[output-contracts/02-CRITICAL-output-table-is-a-lie]], [[output-contracts/03-CRITICAL-output-xml-silently-accepted]]) |
| 2 | Logs/spinners/banners/progress on **stderr** | ❌ | error envelopes go to stderr in JSON mode ([[output-contracts/04-CRITICAL-errors-go-to-stderr-in-json-mode]]); spawned tools' stdout/stderr is silently dropped ([[write-path/03-CRITICAL-spawn-stdio-pipes-dropped]]) |
| 3 | **Exit codes** distinguish success/usage/auth/not-found/conflict/validation/transient | ⚠️ partial | 0/1/2/3/42 used, 4/5/10 declared but never emitted ([[errors/04-MEDIUM-exit-codes-mostly-unused]]); some commander errors leak as plain text ([[output-contracts/05-CRITICAL-send-validation-bypasses-formatter]]); help exits 2 ([[output-contracts/06-CRITICAL-help-output-json-exits-2]]) |
| 4 | Headless runs **never block** without `--no-input`/`--yes`/`--dry-run` | ⚠️ | `prune` has `--yes`/`--dry-run`; `send` lacks `--dry-run` ([[destructive/02-MEDIUM-no-dry-run-on-send]]); spawned-tool buffer-full deadlock risk ([[write-path/03-CRITICAL-spawn-stdio-pipes-dropped]]) |
| 5 | Errors include stable **`code`** + **retryable** | ⚠️ | `code` exists but no `class`; only one site emits `retry: true`; commander-wrapped errors lack `detail`/`suggestion`/`class` ([[errors/03-MEDIUM-no-class-field-in-error]], [[errors/09-MEDIUM-no-retry-semantics]], [[errors/11-MEDIUM-commander-error-no-suggestion]]) |

**Two showstoppers** above and beyond the core checks:
- **`prune --yes` is a no-op disguised as success** ([[destructive/01-CRITICAL-prune-yes-fakes-deletion]]).
- **`detectNewSession` can return another project's session ID** ([[destructive/03-MEDIUM-detect-new-session-fallback-dangerous]] / [[write-path/02-CRITICAL-detect-new-session-attaches-wrong-session]]).

---

## Severity histogram

| Severity | Count |
|---|---|
| Critical | 12 |
| High | 11 |
| Medium | 33 |
| Low | 12 |

(Some files cross-reference the same root cause from two angles — the count above is by file, not by unique bug.)

---

## Highest-leverage fix order (do these first, in this order)

1. **`prune --yes` lies** — refuse with `NOT_IMPLEMENTED` until real deletion lands ([[destructive/01-CRITICAL-prune-yes-fakes-deletion]]).
2. **CWD-awareness on `list`** — the user's #1 ask ([[cwd-aware/01-CRITICAL-no-auto-scope-to-current-directory]]).
3. **Errors to stdout in JSON mode** — single helper, touches every command ([[output-contracts/04-CRITICAL-errors-go-to-stderr-in-json-mode]]).
4. **Send validation through the formatter** — kill the three plain-text stderr paths ([[output-contracts/05-CRITICAL-send-validation-bypasses-formatter]]).
5. **`--output jsonl list` actually JSONL** + reject `xml`/`table`-as-text aliases ([[output-contracts/01-CRITICAL-list-jsonl-is-not-jsonl]], [[output-contracts/02-CRITICAL-output-table-is-a-lie]], [[output-contracts/03-CRITICAL-output-xml-silently-accepted]]).
6. **Help exit 0** — `helpInformation` override exit code fix ([[output-contracts/06-CRITICAL-help-output-json-exits-2]]).
7. **Spawn-pipe hygiene + tool-output capture** ([[write-path/03-CRITICAL-spawn-stdio-pipes-dropped]]).
8. **Send → bad ID → undefined-cmd crash** ([[write-path/01-CRITICAL-send-deadbeef-undefined-cmd-crash]]).
9. **DetectNewSession poll + no-fallback** ([[destructive/03-MEDIUM-detect-new-session-fallback-dangerous]] / [[write-path/02-CRITICAL-detect-new-session-attaches-wrong-session]]).
10. **Hidden commands + actions hint surface** ([[discovery/02-HIGH-hidden-commands-referenced-in-actions]], [[discovery/08-MEDIUM-list-footer-only-one-tip]]).
11. **ETag in `read` envelope + class field on errors** ([[iterative/01-HIGH-etag-not-in-read-response]], [[iterative/02-HIGH-if-changed-no-output-on-match]], [[iterative/03-HIGH-etag-omits-preset-budget]], [[errors/03-MEDIUM-no-class-field-in-error]]).
12. **Job loop carries source/tokens/preset** ([[iterative/04-HIGH-job-poll-loses-source-tokens-preset]]).

After 12 the v2.5.x release is safely agent-driveable. The remaining Mediums and Lows are polish that can ship across v2.6.

---

## File index by context

### `cwd-aware/`
- [01-CRITICAL no auto-scope to current directory](cwd-aware/01-CRITICAL-no-auto-scope-to-current-directory.md)

### `output-contracts/`
- [01-CRITICAL list jsonl is not jsonl](output-contracts/01-CRITICAL-list-jsonl-is-not-jsonl.md)
- [02-CRITICAL --output table is a lie](output-contracts/02-CRITICAL-output-table-is-a-lie.md)
- [03-CRITICAL --output xml silently accepted](output-contracts/03-CRITICAL-output-xml-silently-accepted.md)
- [04-CRITICAL errors go to stderr in json mode](output-contracts/04-CRITICAL-errors-go-to-stderr-in-json-mode.md)
- [05-CRITICAL send validation bypasses formatter](output-contracts/05-CRITICAL-send-validation-bypasses-formatter.md)
- [06-CRITICAL --output json help exits 2](output-contracts/06-CRITICAL-help-output-json-exits-2.md)
- [07-HIGH envelope shapes drift across commands](output-contracts/07-HIGH-envelope-shape-drift.md)
- [08-HIGH no ok and schema_version fields](output-contracts/08-HIGH-no-ok-and-schema-version-fields.md)
- [09-HIGH error envelope shape inconsistency](output-contracts/09-HIGH-error-envelope-shape-inconsistency.md)
- [10-MEDIUM cwd path shortening inconsistent](output-contracts/10-MEDIUM-cwd-path-shortening-inconsistent.md)
- [11-MEDIUM date replacer not used everywhere](output-contracts/11-MEDIUM-date-replacer-not-everywhere.md)
- [12-MEDIUM jsonl read emits redundant blocks](output-contracts/12-MEDIUM-jsonl-read-emits-redundant-blocks.md)
- [13-MEDIUM send always emits blocks](output-contracts/13-MEDIUM-send-always-emits-blocks.md)
- [14-MEDIUM actions after messages — bad streaming order](output-contracts/14-MEDIUM-actions-after-messages-streaming.md)
- [15-LOW --api-version flag is dead](output-contracts/15-LOW-api-version-flag-is-dead.md)
- [16-LOW --timing flag is dead](output-contracts/16-LOW-timing-flag-is-dead.md)
- [17-MEDIUM context/tag/prune ignore --output](output-contracts/17-MEDIUM-context-tag-prune-no-output-flag.md)
- [18-MEDIUM TTY detection is brittle](output-contracts/18-MEDIUM-tty-detection-brittle.md)

### `discovery/`
- [01-HIGH no cwd filter on list](discovery/01-HIGH-no-cwd-filter-on-list.md)
- [02-HIGH hidden commands referenced in actions](discovery/02-HIGH-hidden-commands-referenced-in-actions.md)
- [03-MEDIUM no examples in help](discovery/03-MEDIUM-no-examples-in-help.md)
- [04-MEDIUM workflow hint wrong/incomplete](discovery/04-MEDIUM-workflow-hint-wrong.md)
- [05-MEDIUM source not validated](discovery/05-MEDIUM-source-not-validated.md)
- [06-MEDIUM list numeric bounds not validated](discovery/06-MEDIUM-list-numeric-bounds-not-validated.md)
- [07-MEDIUM no doctor command](discovery/07-MEDIUM-no-doctor-command.md)
- [08-MEDIUM list footer only one tip](discovery/08-MEDIUM-list-footer-only-one-tip.md)
- [09-LOW exit codes not in human help](discovery/09-LOW-exit-codes-not-in-human-help.md)
- [10-LOW no source aliases](discovery/10-LOW-no-source-aliases.md)
- [11-LOW preset help missing token info](discovery/11-LOW-preset-help-no-token-info.md)
- [12-LOW no docs flag](discovery/12-LOW-no-docs-flag.md)
- [13-MEDIUM error suggestions too generic](discovery/13-MEDIUM-error-suggestions-too-generic.md)
- [14-LOW no preset/detail/anchor validation](discovery/14-LOW-no-preset-detail-anchor-validation.md)

### `errors/`
- [01-CRITICAL prune --yes is a no-op](errors/01-CRITICAL-prune-yes-no-op.md)
- [02-HIGH send plain-text stderr errors](errors/02-HIGH-send-plain-text-stderr-errors.md)
- [03-MEDIUM no class field in error](errors/03-MEDIUM-no-class-field-in-error.md)
- [04-MEDIUM exit codes mostly unused](errors/04-MEDIUM-exit-codes-mostly-unused.md)
- [05-MEDIUM getPreset throws plain Error](errors/05-MEDIUM-getpreset-throws-plain-error.md)
- [06-MEDIUM --tokens 0 silent](errors/06-MEDIUM-tokens-zero-silent.md)
- [07-MEDIUM --if-changed swallows errors](errors/07-MEDIUM-if-changed-swallows-errors.md)
- [08-MEDIUM --role bogus → misleading INVALID_RANGE](errors/08-MEDIUM-role-bogus-misleading-invalid-range.md)
- [09-MEDIUM no retry semantics](errors/09-MEDIUM-no-retry-semantics.md)
- [10-MEDIUM parse errors silently swallowed](errors/10-MEDIUM-parse-errors-silently-swallowed.md)
- [11-MEDIUM commander error lacks suggestion](errors/11-MEDIUM-commander-error-no-suggestion.md)
- [12-LOW prune --older-than 0d accepted](errors/12-LOW-prune-zero-duration.md)

### `destructive/`
- [01-CRITICAL prune --yes fakes deletion](destructive/01-CRITICAL-prune-yes-fakes-deletion.md)
- [02-MEDIUM no --dry-run on send](destructive/02-MEDIUM-no-dry-run-on-send.md)
- [03-MEDIUM detectNewSession fallback dangerous](destructive/03-MEDIUM-detect-new-session-fallback-dangerous.md)

### `write-path/`
- [01-CRITICAL send <bad-id> crash](write-path/01-CRITICAL-send-deadbeef-undefined-cmd-crash.md)
- [02-CRITICAL detectNewSession attaches wrong session](write-path/02-CRITICAL-detect-new-session-attaches-wrong-session.md)
- [03-CRITICAL spawn pipes dropped](write-path/03-CRITICAL-spawn-stdio-pipes-dropped.md)
- [04-HIGH job-status stderr heuristic](write-path/04-HIGH-job-status-only-stderr-heuristic.md)
- [05-HIGH kiro resume command broken](write-path/05-HIGH-kiro-resume-command-broken.md)
- [06-HIGH send detect-session-fail exit 0](write-path/06-HIGH-send-detect-session-fail-exit-zero.md)
- [07-MEDIUM job persistence not atomic](write-path/07-MEDIUM-job-persistence-not-atomic.md)
- [08-MEDIUM async no explicit exit code](write-path/08-MEDIUM-async-no-explicit-exit-code.md)
- [09-MEDIUM finalizeJob mutates input](write-path/09-MEDIUM-finalizejob-mutates-input.md)
- [10-MEDIUM spawn error vs exit](write-path/10-MEDIUM-spawn-error-vs-exit.md)
- [11-LOW runners no default case](write-path/11-LOW-runners-no-default-case.md)

### `iterative/`
- [01-HIGH etag not in read response](iterative/01-HIGH-etag-not-in-read-response.md)
- [02-HIGH --if-changed no JSON on match](iterative/02-HIGH-if-changed-no-output-on-match.md)
- [03-HIGH etag omits preset/budget](iterative/03-HIGH-etag-omits-preset-budget.md)
- [04-HIGH job poll loses source/tokens/preset](iterative/04-HIGH-job-poll-loses-source-tokens-preset.md)
- [05-MEDIUM list cursor lacks numeric tokens](iterative/05-MEDIUM-list-cursor-no-numeric-tokens.md)
- [06-MEDIUM detail_hint no fit flag](iterative/06-MEDIUM-detail-hint-no-fit-flag.md)
- [07-MEDIUM no next_action on list/info/stats](iterative/07-MEDIUM-no-next-action-on-list-info-stats.md)
- [08-MEDIUM search no snippets](iterative/08-MEDIUM-search-no-snippets.md)
- [09-MEDIUM list --search 50-cap silent](iterative/09-MEDIUM-list-search-50-cap-silent.md)
- [10-MEDIUM summary on every page](iterative/10-MEDIUM-summary-on-every-page.md)
- [11-MEDIUM pages_estimate inconsistent](iterative/11-MEDIUM-pages-estimate-inconsistent.md)
- [12-MEDIUM resume.verified not runtime](iterative/12-MEDIUM-resume-verified-not-runtime.md)
- [13-LOW JobStatus no cancelled](iterative/13-LOW-jobstatus-no-cancelled.md)
- [14-LOW wait timeout doubles forever](iterative/14-LOW-wait-timeout-doubles-forever.md)
- [15-LOW no batch read](iterative/15-LOW-no-batch-read.md)
- [16-MEDIUM --anchor search without --search](iterative/16-MEDIUM-anchor-search-without-search.md)

### `_probes/`
75 captured stdout/stderr/exit triplets covering help, list (every format + bad source + bounds), read (range/page/tokens/role/preset/etag/anchor), info, stats, search, diff, prune dry-run, jobs/job/wait/cancel, context, send (no-args / new-no-source / mutual-exclusion / bad-id), and `list` from `/tmp` (cwd test).

---

## How the audit was constructed

1. Probed `dist/cli.js` against every command in every output mode and the major failure paths; captured stdout/stderr/exit triples in `_probes/`.
2. Read `src/cli.ts`, every `src/commands/*.ts`, every `src/output/*.ts`, `src/discovery.ts`, `src/errors.ts`, `src/runners.ts`, `src/jobs.ts`, `src/etag.ts`, `src/resume.ts`, `src/types.ts`, `src/config.ts`, and `AGENTS.md`.
3. Dispatched five parallel `Explore` sub-agents (write-path, output-contracts, discovery, errors, iterative) to audit dimensions in parallel and surface evidence with `file:line` citations.
4. Consolidated and de-duped into the file-per-finding layout above. Each finding has Evidence / Why-it-matters / Fix / Verification, and links related findings via `[[name]]`.

---

## What sessionr already does well

To keep perspective:

- The error class system (`SessionReaderError` + subclasses) is well-designed; what's missing is the `class`, `retryable`, and `suggestion` plumbing — the bones are there.
- `read --tokens`, `--anchor`, `--page`, cursor commands, and the `detail_hint` upgrade options are an unusually agent-aware surface for v2.5.x.
- `actions[]` arrays are everywhere — the foundation for the `next_action` work in [[iterative/07-MEDIUM-no-next-action-on-list-info-stats]] is already in place.
- `send --async` + `job` / `wait` / `cancel` is the correct shape for long-running tool calls; the gaps are in payload propagation ([[iterative/04-HIGH-job-poll-loses-source-tokens-preset]]) and exit-code accuracy ([[write-path/04-HIGH-job-status-only-stderr-heuristic]]), not architecture.

The 5-step fix order above plus the cwd-aware change closes the largest agent-readiness gaps without rearchitecting the project.
