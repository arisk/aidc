import { playwright } from '@vitest/browser-playwright';
import { defineConfig, type ViteUserConfig } from 'vitest/config';

const strict = { lines: 95, branches: 95, functions: 95, statements: 95 };

const config: ViteUserConfig = defineConfig({
  test: {
    // The oracle tests log comparison statistics; show them only when a test fails.
    silent: 'passed-only',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.gen.ts'],
      thresholds: {
        'src/core/**': strict,
        'src/ai/**': strict,
        'src/digital-link/**': strict,
        'src/scan/**': strict,
        'src/epc/**': strict,
        'src/symbology/**': { lines: 90, branches: 90, functions: 90, statements: 90 },
      },
    },
    projects: [
      {
        test: {
          name: 'unit',
          environment: 'node',
          include: ['test/**/*.test.ts'],
          exclude: ['test/oracle/**', 'test/oracle-browser/**'],
        },
      },
      {
        // Benchmarks import the built dist (pnpm bench builds first). Native Node loads dist and the
        // few internal src modules the benchmarks need, so no module runner export getter sits
        // on a cross-module call and the figures match what consumers run.
        test: {
          name: 'bench',
          environment: 'node',
          include: [],
          benchmark: { include: ['bench/**/*.bench.ts'] },
          server: { deps: { external: [/[\\/]dist[\\/]/, /[\\/]src[\\/]/] } },
        },
      },
      {
        test: {
          name: 'oracle',
          environment: 'node',
          include: ['test/oracle/**/*.test.ts'],
          testTimeout: 300_000,
        },
      },
      {
        // Pre-bundle up front so Vite does not reload the page mid-run (render research 4.2).
        optimizeDeps: { include: ['zxing-wasm/reader', 'fast-check'] },
        test: {
          name: 'oracle-browser',
          include: ['test/oracle-browser/**/*.test.ts'],
          testTimeout: 300_000,
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            // Firefox cannot launch on every development host; Chromium and WebKit cover the check.
            instances: [{ browser: 'chromium' }, { browser: 'webkit' }],
          },
        },
      },
      {
        test: {
          name: 'browser',
          include: [
            'test/core/**/*.test.ts',
            'test/ai/**/*.test.ts',
            'test/digital-link/**/*.test.ts',
            'test/scan/**/*.test.ts',
            'test/epc/**/*.test.ts',
            'test/symbology/**/*.test.ts',
          ],
          exclude: [
            'test/epc/tdt-conformance.test.ts',
            'test/epc/gs1.test.ts',
            'test/epc/plus-tdt-conformance.test.ts',
            'test/epc/tables.test.ts',
            'test/epc/aidc.test.ts',
          ],
          browser: {
            enabled: true,
            headless: true,
            provider: playwright(),
            instances: [{ browser: 'chromium' }, { browser: 'firefox' }, { browser: 'webkit' }],
          },
        },
      },
    ],
  },
});

export default config;
