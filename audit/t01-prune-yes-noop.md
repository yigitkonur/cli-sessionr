# t01 prune yes noop

## Summary

- `prune --yes` now refuses with `code:"NOT_IMPLEMENTED"` instead of reporting fake deletion success.
- `--dry-run` keeps the existing preview envelope and remains the only supported prune mode.
- `--older-than` now rejects zero durations with `code:"INVALID_DURATION"` and usage exit code 2.
- JSON and JSONL prune errors are written to stdout; text-mode errors remain on stderr.

## Deferred

Real file-backed deletion is intentionally deferred to a follow-up PR.
