# T13 Job Loop State Preservation

## Summary

- Added `read_back` to persisted job records with the original `send` source, token budget, and preset.
- Updated async job creation to populate `read_back` from `SendOptions`.
- Updated job read actions to include `--source`, `--tokens`, and `--preset` when suggesting follow-up `sessionr read` commands.

## Verification

- `pnpm build`
- `pnpm test`
