import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config';

// The tests run with the app's own Vite settings: the React plugin and the globals that
// the source relies on (`__APP_VERSION__`, which anything showing the window frame reads).
// Only what concerns the tests is added here.
export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      environment: 'jsdom',
      setupFiles: ['./src/test/setup.ts'],
      css: false,
      maxWorkers: 1,
      minWorkers: 1,
      // The UI tests take about a second each; the margin is for a busy machine, where a
      // test can take twenty times as long, so that load alone cannot turn a passing test red.
      testTimeout: 30_000,
    },
  }),
);
