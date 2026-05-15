# 05 · MEDIUM · `--preset bogus` exits **1** (`UNKNOWN_ERROR`) instead of **2** (`INVALID_PRESET`)

**Context:** errors · **Severity:** Medium · **Status:** open
**Owners:** `src/config.ts:54-62`

## Evidence

```ts
// src/config.ts:54-62
export function getPreset(name: string): VerbosityPreset {
  const preset = PRESETS[name as PresetName];
  if (!preset) {
    throw new Error(
      `Unknown verbosity preset "${name}". Valid presets: ${Object.keys(PRESETS).join(', ')}`,
    );
  }
  return preset;
}
```

Plain `Error`, no `code`, no `exitCode`. `exitCodeForError` (`src/errors.ts:110-113`) maps it to `EXIT.ERROR` (1). The JSON formatter falls through to `UNKNOWN_ERROR` (`src/output/json.ts:80`).

Probe `_probes/48_read_bad_preset.txt`: exit 1.

## Fix

```ts
import { SessionReaderError, EXIT } from './errors.js';
export function getPreset(name: string): VerbosityPreset {
  const preset = PRESETS[name as PresetName];
  if (!preset) {
    throw new SessionReaderError(`Unknown verbosity preset "${name}"`, {
      code: 'INVALID_PRESET',
      exitCode: EXIT.USAGE,
      detail: { provided: name, valid: Object.keys(PRESETS) },
      suggestion: `sessionr read ${'<id>'} --preset standard`,
    });
  }
  return preset;
}
```

## Verification

```bash
sessionr read <id> --preset bogus --output json 2>&1 | jq '.error.code, .error.class'
# expect "INVALID_PRESET", "validation"
echo $?   # expect 2
```

## Related

- [[discovery/14-LOW-no-preset-detail-anchor-validation]]
