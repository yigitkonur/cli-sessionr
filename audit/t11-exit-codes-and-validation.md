# T11 Exit Codes and Validation Audit

## Scope

- Wired `INVALID_PRESET` and `INVALID_DETAIL` to structured `SessionReaderError` usage errors.
- Added read-command validation for invalid token budgets, roles, anchors, and `--anchor search` without `--search`.
- Marked truncated read slices with `meta.partial = true` and `EXIT.PARTIAL` (`10`).

## Exit Code Semantics

- `EXIT.USAGE` (`2`) is used for invalid CLI input: preset, detail, token budget, role, anchor, and anchor/search usage.
- `EXIT.PARTIAL` (`10`) means the read response is valid but truncated. Agents should check `meta.partial`; if true, either accept the partial response or paginate with the emitted cursor commands.

## Verification

- `pnpm build` passed.
- `pnpm test` passed.
- Added focused read-command tests covering `INVALID_TOKEN_BUDGET`, `INVALID_ROLE`, `INVALID_ANCHOR`, `INVALID_ANCHOR_USAGE`, and `meta.partial` with exit `10`.
- Added config tests covering structured `INVALID_PRESET` and `INVALID_DETAIL` errors.
