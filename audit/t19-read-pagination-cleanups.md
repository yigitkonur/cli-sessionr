# t19 read pagination cleanups

## Scope

- Added shared message serialization for JSON, JSONL, and send output so redundant text-only `blocks` are omitted consistently.
- Reordered `read` JSON envelopes to emit `meta`, `next_action`, and `actions` before `messages`.
- Suppressed repeated `session` summaries after page 1 unless `--include-summary` is passed.
- Added `meta.budget`, `meta.preset`, budget-based `pages_estimate`, and detail upgrade fit fields.
- Added `read --batch <ids.txt>` streaming JSONL for multiple sessions.
- Capped `wait` retry timeout suggestions at 3600 seconds.

## Verification

- `pnpm build` passed.
- `pnpm test` passed: 5 files, 77 tests.
- `read --output jsonl` payload was within 10% of `--output json` for an 8000-token read.
- `read --page 2 --output json` omitted `session`.
- `read --output json` emitted `messages` after `actions`.
- `detail_hint.upgrade_options[0].will_fit_in_current_budget` returned a boolean.
- `read --batch /tmp/sessionr-t19-ids.txt --output jsonl --tokens 1000` emitted `meta`, `session`, and `message` records.
- `send --output json` was verified with an isolated fake Codex runner and text-only messages omitted `blocks`.
