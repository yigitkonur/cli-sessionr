# 14 · LOW · `--preset`, `--detail`, `--anchor`, `--role` accept arbitrary strings

**Context:** discovery · **Severity:** Low · **Status:** open
**Owners:** `src/cli.ts` (read), `src/commands/read.ts:179-184`

## Evidence

- `--preset bogus` → exit 1 with `UNKNOWN_ERROR` (probe `_probes/48_read_bad_preset.txt`) because `getPreset` (`src/config.ts:54-62`) throws plain `Error`.
- `--role bogus` → exit 2 with the misleading `INVALID_RANGE` (probe `_probes/49_read_bad_role.txt`) because filterByRole returns 0 messages, then the range check fires.
- `--anchor` accepts unknown values; the slicer falls back silently.

## Fix

Add `Commander.Option(...).choices([...])` for each; or add manual `assertOneOf` calls in `read.ts` that throw `INVALID_PRESET`/`INVALID_ROLE`/`INVALID_ANCHOR` with `EXIT.USAGE`.

## Verification

```bash
sessionr read <id> --preset extreme --output json 2>&1 | jq .error.code   # expect "INVALID_PRESET"
sessionr read <id> --role banana    --output json 2>&1 | jq .error.code   # expect "INVALID_ROLE"
sessionr read <id> --anchor sideways --output json 2>&1 | jq .error.code  # expect "INVALID_ANCHOR"
```

## Related

- [[errors/05-MEDIUM-getpreset-throws-plain-error]]
- [[errors/08-MEDIUM-role-bogus-misleading-invalid-range]]
