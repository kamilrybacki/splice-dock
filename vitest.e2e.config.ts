import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    setupFiles: ['tests/setup/log-sink.ts'],
    testTimeout: 30000,
  },
})
