# T05 Help Exits Zero Audit

## Change

- Broadened the top-level `CommanderError` success classifier to include:
  - `commander.help`
  - `commander.helpDisplayed`
  - `commander.version`

## Verification

- `node dist/cli.js --output json help` exits 0, stderr 0 bytes.
- `node dist/cli.js --output json help send` exits 0, stderr 0 bytes.
- `node dist/cli.js --output json help list` exits 0, stderr 0 bytes.
- `node dist/cli.js help send` exits 0, stderr 0 bytes.
- `node dist/cli.js --version` exits 0, stderr 0 bytes.
- `node dist/cli.js list --help` exits 0, stderr 0 bytes.
- `node dist/cli.js --bogus` exits 2, stderr 0 bytes.
- `node dist/cli.js list bogusarg-but-actually-bad` exits 0, unchanged from current behavior.
- `pnpm build` exits 0.
- `pnpm test` passes: 5 files, 61 tests.
