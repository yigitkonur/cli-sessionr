## [3.0.0](https://github.com/yigitkonur/cli-sessionr/compare/v2.9.0...v3.0.0) (2026-05-28)

### ⚠ BREAKING CHANGES

* **send:** every command now emits the v2 envelope
{ ok, schema_version: "v2", result | error, meta, actions }. The v2.x shapes
are gone: no top-level api_version, no `data` wrapper on send/job, error uses
`class` + `retryable` (was `retry`), and all keys are snake_case. See
MIGRATION.md. This is the sessionr 3.0.0 release.
* Phase 2 — close 13 HIGH agent-readiness issues + envelope sweep
* Phase 1 — close 12 CRITICAL agent-readiness issues

### Features

* **envelope:** v3 canonical envelope + emit + --timing wiring ([1b31f3c](https://github.com/yigitkonur/cli-sessionr/commit/1b31f3cd6321e504fa31af4afe1cca67d3a0b347))
* Phase 1 — close 12 CRITICAL agent-readiness issues ([a7070f5](https://github.com/yigitkonur/cli-sessionr/commit/a7070f5ccc959cbb28e24681f105c9e96714ab17))
* Phase 2 — close 13 HIGH agent-readiness issues + envelope sweep ([b5918d4](https://github.com/yigitkonur/cli-sessionr/commit/b5918d4ba8470e578fd90789efda669a65bf4603))
* Phase 3 — close ~45 MEDIUM issues + 5 of my audit findings ([ae7cd55](https://github.com/yigitkonur/cli-sessionr/commit/ae7cd55ee827b09527e4c85c7f562e6e26a63f99))

### Bug Fixes

* **ci:** enable npm OIDC trusted publishing (npm>=11.5.1, token-free) ([7b9e2df](https://github.com/yigitkonur/cli-sessionr/commit/7b9e2df029197b2452918f2c97c81e2291fd7404))
* **ci:** suppress node:sqlite ExperimentalWarning + skip real-session tests on CI ([4251010](https://github.com/yigitkonur/cli-sessionr/commit/42510103d197de6e2e49893a731ca7f1121e0e54))
* close all 8 Codex adversarial-review findings (H1-H3, M4-M7, L8) ([7711194](https://github.com/yigitkonur/cli-sessionr/commit/7711194d4308ac4e4165f354dd951217fa6c746a))
* **envelope:** canonical snake_case via toExternal() — close H2/Phase 2 BLOCKING ([d21ced2](https://github.com/yigitkonur/cli-sessionr/commit/d21ced2b6f7b0a05acce00a1e1502f1b0e6a9bb5))
* **errors:** set errorClass on existing SessionReaderError subclasses ([92e715d](https://github.com/yigitkonur/cli-sessionr/commit/92e715dfe69ab6bc2ecc4a74d7fa3f3b9c745b52))
* **prune:** validate --output upfront so unknown formats hit oc/03 envelope ([6732875](https://github.com/yigitkonur/cli-sessionr/commit/6732875fe0ff1cceba31d8f8ddfa407c60012807))
* **release:** detect breaking changes so the v3 hard break bumps major ([0687c1b](https://github.com/yigitkonur/cli-sessionr/commit/0687c1b581a702c82e206f57d252dfcd733ac4eb))
* **send:** route success paths through the v2 envelope (final-review blocker) ([3b5cfc0](https://github.com/yigitkonur/cli-sessionr/commit/3b5cfc0424d7b1bea921f6322e43fb916eb7fbd8))

## [2.9.0](https://github.com/yigitkonur/cli-sessionr/compare/v2.8.1...v2.9.0) (2026-05-15)

### Features

* **skills:** bundle use-sessionr Claude skill + one-line install ([f7e8dc3](https://github.com/yigitkonur/cli-sessionr/commit/f7e8dc3c6cc6dfb2c5ddd8d4557c96e912ac4be2))

## [2.8.1](https://github.com/yigitkonur/cli-sessionr/compare/v2.8.0...v2.8.1) (2026-05-15)

### Bug Fixes

* **read:** anchor messages = leading system/user run + last assistant ([0c47f5a](https://github.com/yigitkonur/cli-sessionr/commit/0c47f5aff14f51a4bef5e84eeb8b7bc8be72f3d3))

## [2.8.0](https://github.com/yigitkonur/cli-sessionr/compare/v2.7.1...v2.8.0) (2026-05-15)

### Features

* **read:** never truncate the first or last message of a session ([ee21529](https://github.com/yigitkonur/cli-sessionr/commit/ee21529a1754b8c4d9893816d63adabdb413b275)), closes [#1172](https://github.com/yigitkonur/cli-sessionr/issues/1172) [#1](https://github.com/yigitkonur/cli-sessionr/issues/1)

## [2.7.1](https://github.com/yigitkonur/cli-sessionr/compare/v2.7.0...v2.7.1) (2026-05-15)

### Bug Fixes

* **cli:** runtime crash from duplicate --cwd + thread package version ([33dc2a2](https://github.com/yigitkonur/cli-sessionr/commit/33dc2a2066cc8998858bd5f5f30e39336de60a6e))

## [2.7.0](https://github.com/yigitkonur/cli-sessionr/compare/v2.6.0...v2.7.0) (2026-05-15)

### Features

* **cwd-scope:** make list cwd-aware ([6328610](https://github.com/yigitkonur/cli-sessionr/commit/63286103dd1fa6552b22f00846f2c8f811a6784e))
* **doctor:** add setup diagnostics ([91f6d5b](https://github.com/yigitkonur/cli-sessionr/commit/91f6d5b9a175666ce062c4f56c37226589c907c3))
* **list-footer:** add action menu ([ba02ae0](https://github.com/yigitkonur/cli-sessionr/commit/ba02ae01e2bd47a2b516a2d3bb413558e3327e4d))
* **search:** add snippets and list scan meta ([943f107](https://github.com/yigitkonur/cli-sessionr/commit/943f1071b62c4b1c785a6cd0fce568f8b7c7a695))

### Bug Fixes

* **build:** repair list/read/search after orchestrator merge churn ([4c78cd0](https://github.com/yigitkonur/cli-sessionr/commit/4c78cd02c2c1ce2db4be226ee59e1ed39b4ffa0f))
* **ci:** permissive regex for emoji-prefixed conventional commits ([ca88931](https://github.com/yigitkonur/cli-sessionr/commit/ca8893178b5546b857fc840d0f602243d71fe4c5))
* **ci:** permissive regex for emoji-prefixed conventional commits ([1c070c7](https://github.com/yigitkonur/cli-sessionr/commit/1c070c75f6334435d7016408559470b2c3e815c2))
* **cli:** treat help as success ([99cf244](https://github.com/yigitkonur/cli-sessionr/commit/99cf2442b18e0e9c472ee55144b92279a0311763))
* **cli:** validate source and numbers ([107f8eb](https://github.com/yigitkonur/cli-sessionr/commit/107f8eb2f3c9bec995be4c77fa4fcb750a8e0d7e))
* **imports:** add missing cmdPrefix imports across 13 call sites ([f335649](https://github.com/yigitkonur/cli-sessionr/commit/f335649ca345198bdb71d98540408e7d81ade60e))
* **job-loop:** preserve read options ([1c78353](https://github.com/yigitkonur/cli-sessionr/commit/1c78353672deaa1d8e06281da87dd70f6bff94e6))
* **jobs:** record real async exit codes ([b0a15d9](https://github.com/yigitkonur/cli-sessionr/commit/b0a15d92481951b4c19c940723b975fb21cba885))
* **kiro-resume:** refuse targeted sends ([5de135e](https://github.com/yigitkonur/cli-sessionr/commit/5de135e67c45c8c15fd7fbe45bb55263a5a6a6ab))
* **prune:** refuse unimplemented deletion ([4564a9e](https://github.com/yigitkonur/cli-sessionr/commit/4564a9ebaf1f600b34f578c6a4597720b11fcd51))
* **read:** clean pagination payloads ([4a05a5e](https://github.com/yigitkonur/cli-sessionr/commit/4a05a5e2084a051b14eb0d5f7b6c776455e4321d))
* **read:** emit usable etags ([e9d6a5a](https://github.com/yigitkonur/cli-sessionr/commit/e9d6a5ae78fa8a8e4e48857d6fa3a714578a6581))
* **read:** set meta.partial=true and exit PARTIAL on token-truncated slices ([5b65b2f](https://github.com/yigitkonur/cli-sessionr/commit/5b65b2fa4ed859e25f3396089f20b3ff3775e4a4))
* **read:** set meta.partial=true and exit PARTIAL on token-truncated slices ([deeafb7](https://github.com/yigitkonur/cli-sessionr/commit/deeafb796d54c5aca2390aaf7ad22d6b8bf7a74b))
* **read:** validate exit code inputs ([675713e](https://github.com/yigitkonur/cli-sessionr/commit/675713ecfcc125a68f580fd8ee86184cc27322ce))
* **send:** capture sync spawn output ([df8857c](https://github.com/yigitkonur/cli-sessionr/commit/df8857cd0d1f945439e27e2296b682194e092956))
* **send:** handle missing sessions ([2fa0914](https://github.com/yigitkonur/cli-sessionr/commit/2fa0914a0aa07be5d3fe12af72cc60c537927a22))
