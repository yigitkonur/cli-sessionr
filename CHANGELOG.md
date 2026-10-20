## [4.0.1](https://github.com/yigitkonur/cli-sessionr/compare/v4.0.0...v4.0.1) (2026-10-20)

### Bug Fixes

* antigravity resume uses --conversation -p, generated commands carry the full session id, doctor checks the spawned binary ([bb681c4](https://github.com/yigitkonur/cli-sessionr/commit/bb681c40c0a60f4c78fc5d6cdbda72658ea3b7d2))
* **build:** make dist/cli.js executable ([9c6a694](https://github.com/yigitkonur/cli-sessionr/commit/9c6a69494d190077624d95105a6e16ccf63c876b))
* **cli:** help <command> works and rejects unknown commands, source lists include antigravity ([e6df2fc](https://github.com/yigitkonur/cli-sessionr/commit/e6df2fcb6fb2158643c337faa641dee8f9325312))
* **context:** reject an unknown --format with INVALID_FORMAT (exit 2) ([719359d](https://github.com/yigitkonur/cli-sessionr/commit/719359d70cf2fbeb6e72539e65a302d72e74bffc))
* **jobs:** filter by the displayed status and reject unknown --status values ([66ad72f](https://github.com/yigitkonur/cli-sessionr/commit/66ad72f3fc41b7b016eb33a84d09778f9d4a4325))
* **turns:** a Claude session started from a slash command gets turn 1 ([01c188f](https://github.com/yigitkonur/cli-sessionr/commit/01c188f9dffa1d8b671a8b0c6051bdb4ec34945f))

## [4.0.0](https://github.com/yigitkonur/cli-sessionr/compare/v3.0.0...v4.0.0) (2026-10-20)

### ⚠ BREAKING CHANGES

* --after/--before are now exclusive, by_role.user counts human prompts only, partial means budget truncation (see MIGRATION.md)

### Features

* **api:** export programmatic read(), loadSessionByPath, and registerSource (closes [#5](https://github.com/yigitkonur/cli-sessionr/issues/5)) ([c0709d2](https://github.com/yigitkonur/cli-sessionr/commit/c0709d2cfd0ab05b21633ebafe44483bf9f6c0dd))
* **claude:** expose per-turn completion events outside messages ([802d0ea](https://github.com/yigitkonur/cli-sessionr/commit/802d0ea94e8a2f966e6dc3cd533700135096f388))
* **compaction:** normalize compaction boundaries into system messages and stats.compactions (closes [#9](https://github.com/yigitkonur/cli-sessionr/issues/9)) ([05737f9](https://github.com/yigitkonur/cli-sessionr/commit/05737f9ab0eeab230005a1e8a1c8cfda0357b27c))
* **parser:** add agy (Antigravity CLI) source adapter (closes [#4](https://github.com/yigitkonur/cli-sessionr/issues/4)) ([f55a258](https://github.com/yigitkonur/cli-sessionr/commit/f55a2586b2c2b014f75eafa97ae7081fc7998be4))
* **tokens:** track per-turn usage, context window size, effort, and rate limits (closes [#8](https://github.com/yigitkonur/cli-sessionr/issues/8)) ([1e2a691](https://github.com/yigitkonur/cli-sessionr/commit/1e2a691894fbf8ccf0acb303a56f879f2684b881))
* **turns:** extract per-turn execution facts, files changed, commands and errors (closes [#13](https://github.com/yigitkonur/cli-sessionr/issues/13)) ([8a8d62a](https://github.com/yigitkonur/cli-sessionr/commit/8a8d62a55217fed1698d7317520aa4dcabfe6837))
* **turns:** implement turn segmentation with stable IDs and --turn filtering (closes [#12](https://github.com/yigitkonur/cli-sessionr/issues/12)) ([30d366c](https://github.com/yigitkonur/cli-sessionr/commit/30d366c61173dcdf328e305119a151826b3d54fb))

### Bug Fixes

* **agy:** determine emptiness from conversation evidence ([fe7b754](https://github.com/yigitkonur/cli-sessionr/commit/fe7b7549fd786cfd3fe45e011392ae98de71cf64))
* **agy:** include antigravity in the list source catalog ([eea4b39](https://github.com/yigitkonur/cli-sessionr/commit/eea4b391e6c0e7e796a02f94de5ee859f212fe82))
* **agy:** link background task completions to their calls ([6d2ab2f](https://github.com/yigitkonur/cli-sessionr/commit/6d2ab2f2a9af9efd684b9b3ee2d73250d267a003))
* **agy:** prefer transcript_full.jsonl over the truncated transcript ([e74b7f9](https://github.com/yigitkonur/cli-sessionr/commit/e74b7f92021390b61787445ccea19265c56f3e6f))
* **agy:** prefer user requests over system preambles in summaries ([60d846a](https://github.com/yigitkonur/cli-sessionr/commit/60d846a420dcbbc8b2b99e3d885871bb24fe1faa))
* **agy:** quote resume hints and mirror runner arguments ([d6c3994](https://github.com/yigitkonur/cli-sessionr/commit/d6c399439fc68a10936e0e2651bdf8d78746cb3f))
* **agy:** recognize agent-started mission prompts ([6db34b5](https://github.com/yigitkonur/cli-sessionr/commit/6db34b5ec785a7131590e7771467f0e875c50ef9))
* **agy:** skip malformed record shapes and field types ([c5c329e](https://github.com/yigitkonur/cli-sessionr/commit/c5c329edfd09fbc99197ae3a62cd3c8b984b8829))
* **api:** always close format-sniff file descriptors ([4add128](https://github.com/yigitkonur/cli-sessionr/commit/4add12879fb358f1bd3a7309b96e6d1f7b4cec7c))
* **api:** detect sessions from canonical roots and record shapes ([ef6a137](https://github.com/yigitkonur/cli-sessionr/commit/ef6a137ca1f71436aad2920ef5889dcc668bd3b4))
* **api:** distinguish role-filtered views in etags ([a415277](https://github.com/yigitkonur/cli-sessionr/commit/a415277b0276ed08d86a2b051ef9544e2b87ce0b))
* **api:** give read() the same slicing inputs as the CLI ([4ffd08a](https://github.com/yigitkonur/cli-sessionr/commit/4ffd08a0d5c447e7626925e43caf2bb6155190bd))
* **api:** make read() honest about budgets, pages, empty sessions and exhausted cursors ([4d9c4a6](https://github.com/yigitkonur/cli-sessionr/commit/4d9c4a6e675e16f220bb07507bf6ddb1e49cfc19))
* **api:** preserve aliases after mixed-case source replacement ([99481d0](https://github.com/yigitkonur/cli-sessionr/commit/99481d000459cec366e4fdcd055822d6ab7aa7fd))
* **api:** preserve original indexes when filtering roles ([bca9a09](https://github.com/yigitkonur/cli-sessionr/commit/bca9a09102a020016da8b34bd7038031518f53a2))
* **api:** refuse to load goose/opencode sessions from outside their own store ([cabeca8](https://github.com/yigitkonur/cli-sessionr/commit/cabeca8841e92ff4523bbc18a92b2e7ab071c090))
* **api:** reject nonpositive and nonfinite token budgets ([35d42c9](https://github.com/yigitkonur/cli-sessionr/commit/35d42c9c3d0f748327de103a9ddf5c6b85eea3fe))
* **api:** support typed custom adapter sources safely ([f976385](https://github.com/yigitkonur/cli-sessionr/commit/f976385d17ee0fc967f0b00bf5887888886baed7))
* **api:** surface invalid discovery source errors ([905efdc](https://github.com/yigitkonur/cli-sessionr/commit/905efdc94086cfe2b01358f76e97043bfca71b9d))
* **claude:** anchor interrupt markers and honor human provenance ([11dea58](https://github.com/yigitkonur/cli-sessionr/commit/11dea580461907b74a34d47d70e1c4ffcf47a832))
* **claude:** classify non-prompt user records and exclude from stats.byRole.user (fixes [#16](https://github.com/yigitkonur/cli-sessionr/issues/16)) ([1470bc3](https://github.com/yigitkonur/cli-sessionr/commit/1470bc33514803630095de2fde425fb1e985ab30))
* **claude:** classify observed cross-session peer preambles ([8f57e3d](https://github.com/yigitkonur/cli-sessionr/commit/8f57e3d8a09882ece66aadb6e4d75a17817dbddb))
* **claude:** classify queued task-notification attachments as notifications ([6aa7b67](https://github.com/yigitkonur/cli-sessionr/commit/6aa7b67e508a373adf63bea3ca0607279cfb2035)), closes [#21](https://github.com/yigitkonur/cli-sessionr/issues/21)
* **claude:** distinguish notification attachments from absorbed prompts ([cf31424](https://github.com/yigitkonur/cli-sessionr/commit/cf31424cc2cf1f4fe79496821c982462cc2510d9))
* **claude:** honor hidden metadata on absorbed attachments ([e0ad189](https://github.com/yigitkonur/cli-sessionr/commit/e0ad189ad6db512a8c8b00a7eb0c6d425506f592))
* **claude:** ingest mid-turn absorbed commands and expose turn duration (fixes [#14](https://github.com/yigitkonur/cli-sessionr/issues/14)) ([5449bfe](https://github.com/yigitkonur/cli-sessionr/commit/5449bfe44ca765a1eeab68c1e179a998d249bd3d))
* **claude:** keep usage from responses with no renderable content in session stats ([e55e1e6](https://github.com/yigitkonur/cli-sessionr/commit/e55e1e6d33c58410b9c36ea9f21ca3c0a0b2a97b))
* **claude:** normalize notifications with the system role ([39ba265](https://github.com/yigitkonur/cli-sessionr/commit/39ba26597a300f1077e2505591f9e253a64d8389))
* **claude:** normalize unknown queued prompt content to text ([4356278](https://github.com/yigitkonur/cli-sessionr/commit/4356278792adc345d4222361d367be2e15f30b27))
* **claude:** prefer physical raw indices for absorbed attachments ([cff42b1](https://github.com/yigitkonur/cli-sessionr/commit/cff42b140aea52fa03ca032000a8617bd3f26405))
* **claude:** preserve absorbed prompt origin kind ([bb72ede](https://github.com/yigitkonur/cli-sessionr/commit/bb72edeac66bd0d71b89a3dead2936b02ed6d9b3))
* **claude:** preserve physical line index across streaming de-duplication (fixes [#15](https://github.com/yigitkonur/cli-sessionr/issues/15)) ([e904c1e](https://github.com/yigitkonur/cli-sessionr/commit/e904c1e906721c0c7def21c408c1298850eba020))
* **claude:** recognize exact unnamed tool-use interrupts ([6304b1e](https://github.com/yigitkonur/cli-sessionr/commit/6304b1e6de99c3238b2dd3f8d1e70270de8f14fb))
* **claude:** report the physical line index on compaction messages ([e80c6b4](https://github.com/yigitkonur/cli-sessionr/commit/e80c6b4df7aa08dd7cfc855da376aaeed6eaa2ef))
* **claude:** restrict durations to valid turn completion records ([498dc0a](https://github.com/yigitkonur/cli-sessionr/commit/498dc0a9b9afbd4277fe3981a15a836b36f0735e))
* **claude:** skip turn_duration records with malformed timestamps ([ae6a2e3](https://github.com/yigitkonur/cli-sessionr/commit/ae6a2e3022cb21577a5f2ff7bfb0de12246e113d))
* **claude:** treat peer-message wrappers as non-human ([79253da](https://github.com/yigitkonur/cli-sessionr/commit/79253da6ab84cae82cbef7f62ba14b3390f831d0))
* **codex:** decode JavaScript string literals without evaluation ([1c7fa0b](https://github.com/yigitkonur/cli-sessionr/commit/1c7fa0babf5b1bd663eb3baa8acde35aab0cbc44))
* **codex:** detect failures inside text-block exec results ([311c169](https://github.com/yigitkonur/cli-sessionr/commit/311c1693749854562f6a7de7d779df7608238b0f))
* **codex:** distinguish exec invocations from patch contents ([828075d](https://github.com/yigitkonur/cli-sessionr/commit/828075d6de6bd28a6d84db776d2ef0423cf6a046))
* **codex:** keep a forked session's own id instead of its parent's ([8db8b8c](https://github.com/yigitkonur/cli-sessionr/commit/8db8b8c8d5eb2d4d4cf46f0781083b8dcea006ea))
* **codex:** preserve JSON command argv arrays ([a35bd4d](https://github.com/yigitkonur/cli-sessionr/commit/a35bd4dacfc079124f78f32b2262b69f9ea4481b))
* **codex:** preserve literal patch paths and diff header context ([7ac5590](https://github.com/yigitkonur/cli-sessionr/commit/7ac55900acf71333b1fa9eace96ea269d8981351))
* **codex:** preserve quoted command keys in selected calls ([58f2f20](https://github.com/yigitkonur/cli-sessionr/commit/58f2f201370f3219c739004aded5a4322967d0ec))
* **codex:** read only literal top-level invocation arguments ([41d4053](https://github.com/yigitkonur/cli-sessionr/commit/41d405391a2f43dad98258b6fcaf49cb8e58d7ec))
* **codex:** retain wrapped tool names and static arguments ([f06b7d9](https://github.com/yigitkonur/cli-sessionr/commit/f06b7d9330075eae1c24e557a264d80c6fb0ecef))
* **codex:** store one canonical decoded patch argument ([c4db6af](https://github.com/yigitkonur/cli-sessionr/commit/c4db6af43459909af268d4d6ce73b06670f592be))
* **codex:** unroll exec tool calls, detect errors and extract patched files (fixes [#7](https://github.com/yigitkonur/cli-sessionr/issues/7)) ([d8fd064](https://github.com/yigitkonur/cli-sessionr/commit/d8fd0646e4151d7bce26c5223c950bc5ef392dbd))
* **compaction:** count emitted summaries in the token budget; ignore markers for turn completion ([b9cf047](https://github.com/yigitkonur/cli-sessionr/commit/b9cf047f3fb0a2fa0c6f1bb3d49be8905fa0eee9))
* **compaction:** preserve boundaries and gate summaries at full detail ([d370f2f](https://github.com/yigitkonur/cli-sessionr/commit/d370f2fdd78f2f7ba4916735d8d73512c779d478))
* **cursor:** keep complete forward and backward pagination walks ([b7c43f6](https://github.com/yigitkonur/cli-sessionr/commit/b7c43f66afcf7ddf8d0b5d9922bbafa0f4108c9b))
* **cursor:** make --after and --before strictly exclusive to prevent duplicate paging (fixes [#11](https://github.com/yigitkonur/cli-sessionr/issues/11)) ([011e45e](https://github.com/yigitkonur/cli-sessionr/commit/011e45ebd09421795c493760ecf7f41e9e352d52))
* **output:** serialize Claude source provenance independently ([9f0325d](https://github.com/yigitkonur/cli-sessionr/commit/9f0325ddae4e393b618a5200270cec0a15b88d3d))
* **read:** bound turn pending-call inputs and keep turn meta on empty cursor slices ([faeaf4c](https://github.com/yigitkonur/cli-sessionr/commit/faeaf4c9b2f57068310cec0ffe6a3d841ab67e3c))
* **read:** keep pending_tool_calls in the empty cursor-boundary response ([0172278](https://github.com/yigitkonur/cli-sessionr/commit/017227883279bf71546d266df5ed160a5a65cda0))
* **read:** omit non-prompts from minimal and standard views ([581facd](https://github.com/yigitkonur/cli-sessionr/commit/581facd5f51f0c66ef23837e0404250e38d31970))
* **search:** report non-matching query explicitly and support searching tool inputs (fixes [#10](https://github.com/yigitkonur/cli-sessionr/issues/10)) ([9d8319f](https://github.com/yigitkonur/cli-sessionr/commit/9d8319f0a70dc82ca69dae35dbb600e129cdd555))
* **search:** retain matches and honor search fields consistently ([e83f990](https://github.com/yigitkonur/cli-sessionr/commit/e83f990ca44fc96dee11037eacc0a1ed5e9077c8))
* **slicer:** measure partial against the requested slice, not the whole session ([a0ee2d6](https://github.com/yigitkonur/cli-sessionr/commit/a0ee2d6d84cc6bf5d31f993e83cc3320000d0d13)), closes [#23](https://github.com/yigitkonur/cli-sessionr/issues/23)
* **slicer:** preserve and bound pending tool call metadata ([d2616bb](https://github.com/yigitkonur/cli-sessionr/commit/d2616bb78d05f00b471863ce7c4f10e9f02fd65e))
* **slicer:** preserve trailing unresolved tool calls and expose pending_tool_calls (fixes [#6](https://github.com/yigitkonur/cli-sessionr/issues/6)) ([0094907](https://github.com/yigitkonur/cli-sessionr/commit/0094907acbebade4e70fba12b7910cd3ff2ac7e9))
* **tokens:** clear obsolete per-turn rate snapshots ([8a1fbde](https://github.com/yigitkonur/cli-sessionr/commit/8a1fbdef0665816e603f5e1e6f28fa79bdeaaa5d))
* **tokens:** preserve request usage and current context snapshots ([518f02d](https://github.com/yigitkonur/cli-sessionr/commit/518f02d2adc69e6f360d8129e66fe543d79f728c))
* **tokens:** retain cache writes and distinguish unreported usage ([312d713](https://github.com/yigitkonur/cli-sessionr/commit/312d713d76aa16f925884ba363bcbb9054f809c5))
* **turns:** include successful notebook edit targets ([ae2f461](https://github.com/yigitkonur/cli-sessionr/commit/ae2f461187e4a70dbeb7cee85c366fa9da9a0fc7))
* **turns:** page against the turn window, keep cursor.first valid, bound command metadata ([ec96c30](https://github.com/yigitkonur/cli-sessionr/commit/ec96c30c759f30cc5a24c713266b5872883b37d2))
* **turns:** preserve prompt provenance and successful execution facts ([2d20a3d](https://github.com/yigitkonur/cli-sessionr/commit/2d20a3dea0aabb3cbeffd3458c649fedf65a9aa0))
* **turns:** use Claude-reported turn durations and join argv-array commands ([140ff5a](https://github.com/yigitkonur/cli-sessionr/commit/140ff5a75f32309d6a575e16ce440b345fb92986)), closes [#21](https://github.com/yigitkonur/cli-sessionr/issues/21) [#18](https://github.com/yigitkonur/cli-sessionr/issues/18)

### Refactoring

* **serialize:** drop duplicate message source emission after merge ([b1e4352](https://github.com/yigitkonur/cli-sessionr/commit/b1e4352c1722d51d0b92a570f87b110df3e1354f)), closes [#19](https://github.com/yigitkonur/cli-sessionr/issues/19) [#21](https://github.com/yigitkonur/cli-sessionr/issues/21)

### Docs

* --after/--before are now exclusive, by_role.user counts human prompts only, partial means budget truncation (see MIGRATION.md) ([1c499fd](https://github.com/yigitkonur/cli-sessionr/commit/1c499fd0669431a88f3d299de1a9ccca3531371f))

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
