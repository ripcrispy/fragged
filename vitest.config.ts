import { defineConfig } from 'vitest/config';
export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    testTimeout: 60000,
    hookTimeout: 180000,
    globalSetup: ['tests/global-setup.ts'],
    env: { NODE_ENV: 'test', AUTH_DEV_PROVIDER: '1', DATA_DIR: 'data/test' },
    pool: 'forks',
    fileParallelism: true,
    maxWorkers: 3,
  },
  esbuild: { jsx: 'automatic', jsxImportSource: 'hono/jsx' },
});
