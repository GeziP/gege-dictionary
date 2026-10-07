import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    maxWorkers: 1,
    minWorkers: 1,
    // The UI tests take about a second each; the margin is for a busy machine, so that
    // load alone cannot turn a passing test red.
    testTimeout: 15_000,
  },
});
