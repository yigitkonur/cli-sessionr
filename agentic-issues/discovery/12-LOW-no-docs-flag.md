# 12 · LOW · No discoverable docs URL or `--docs` flag

**Context:** discovery · **Severity:** Low · **Status:** open
**Owners:** `src/cli.ts`

Add either:

- `program.option('--docs', 'Print docs URL and exit')` returning the GitHub README anchor for the section closest to the command, OR
- `sessionr docs [section]` to print short markdown blocks (presets, sources, exit-codes, workflow).

Agents fetch docs by URL today; embedding the resolution in the CLI removes one round trip.
