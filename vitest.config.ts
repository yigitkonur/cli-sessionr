import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.ts'],
    // Several regression suites spawn the built CLI (`dist/cli.js`) which does
    // a cold-cache scan of every session source on first run. On a machine
    // with thousands of real sessions that scan can take ~9s, so a 10s
    // per-test timeout left no headroom and the suite flaked under parallel
    // fork contention. 30s gives comfortable margin.
    testTimeout: 30000,
    hookTimeout: 60000,
    // Cap concurrent spawns: the spawn-based e2e tests fork `node dist/cli.js`,
    // and running every file in parallel oversubscribes the box (EAGAIN /
    // empty stdout / timeouts). A small pool keeps the suite deterministic on
    // a single developer machine without serializing everything.
    // Vitest 4 moved maxForks/minForks to the top-level maxWorkers/minWorkers.
    pool: 'forks',
    maxWorkers: 4,
    minWorkers: 1,
  },
});
