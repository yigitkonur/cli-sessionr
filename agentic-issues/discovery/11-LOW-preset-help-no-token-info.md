# 11 · LOW · `--preset` help text omits the per-preset token cost

**Context:** discovery · **Severity:** Low · **Status:** open
**Owners:** `src/cli.ts:68`, `src/config.ts:3-52`

Today: `Verbosity preset (minimal, standard, verbose, full)`.

Suggested:

```
Verbosity preset:
  minimal   80 char content / hide tools / ~200 tok
  standard  500 char / 60 char tool args / 80 char tool results / ~600 tok
  verbose   2000 char / 200 char tools / 500 char results / + thinking / ~1500 tok
  full      unlimited / + thinking / ~3000+ tok
Default: verbose for agents, standard for TTY.
```

Agents picking a preset under a `--tokens` budget then have a real estimate instead of guessing.
