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
