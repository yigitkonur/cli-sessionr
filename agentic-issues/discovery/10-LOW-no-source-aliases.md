# 10 · LOW · No source aliases (`cc`, `cli`, `gm`)

**Context:** discovery · **Severity:** Low · **Status:** open
**Owners:** `src/parsers/registry.ts`

Adding aliases is cheap and reduces typo retries.

```ts
const ALIASES: Record<string, SessionSource> = {
  cc: 'claude', claude: 'claude',
  cli: 'copilot', copilot: 'copilot', 'copilot-cli': 'copilot',
  cx: 'codex', codex: 'codex',
  gm: 'gemini', gemini: 'gemini',
};
function resolveSource(s?: string): SessionSource | undefined {
  if (!s) return undefined;
  return ALIASES[s.toLowerCase()] ?? (s as SessionSource);
}
```

Combine with [[discovery/05-MEDIUM-source-not-validated]] so unrecognized aliases still error cleanly.
