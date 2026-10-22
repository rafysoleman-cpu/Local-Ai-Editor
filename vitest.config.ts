import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, 'electron/shared'),
      '@backend': path.resolve(__dirname, 'src/backend'),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/unit/**/*.test.ts', 'tests/integration/**/*.test.ts', 'tests/security/**/*.test.ts'],
    testTimeout: 30000,
    hookTimeout: 30000,
    reporters: ['default'],
  },
});
