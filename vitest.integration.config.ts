import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config'

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['tests/integration/**/*.test.ts'],
      pool: 'forks',
      poolOptions: { forks: { singleFork: true } },
      // Closes the shared mysql2 pool exactly once, after every file is
      // done. See tests/integration/_teardown.ts for rationale.
      globalSetup: ['./tests/integration/_teardown.ts'],
    },
  }),
)
