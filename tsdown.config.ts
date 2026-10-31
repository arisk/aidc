import { defineConfig, type UserConfig } from 'tsdown';

const config: UserConfig = defineConfig({
  entry: {
    index: 'src/index.ts',
    core: 'src/core/index.ts',
    ai: 'src/ai/index.ts',
    'digital-link': 'src/digital-link/index.ts',
    scan: 'src/scan/index.ts',
    epc: 'src/epc/index.ts',
    render: 'src/symbology/render/index.ts',
    'ean-upc': 'src/symbology/linear/ean-upc.ts',
    itf: 'src/symbology/linear/itf.ts',
    'gs1-128': 'src/symbology/linear/gs1-128.ts',
    datamatrix: 'src/symbology/matrix/datamatrix.ts',
    qr: 'src/symbology/matrix/qr.ts',
  },
  format: 'esm',
  platform: 'neutral',
  target: 'es2022',
  dts: true,
  sourcemap: false,
  clean: true,
  treeshake: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  // codeSplitting.includeDependenciesRecursively = false requires this; it is rolldown's implicit value.
  inputOptions: { preserveEntrySignatures: 'allow-extension' },
  outputOptions: {
    codeSplitting: {
      groups: [
        {
          // The entry code and Reed-Solomon shared by the 2D symbologies get a chunk of their own,
          // so the Digital Link carrier chunk holds only the carrier (and its name says so).
          name: 'matrix-common',
          test: /src[\\/](symbology[\\/]matrix[\\/]common|core[\\/](gf256|reed-solomon))\.ts$/,
          includeDependenciesRecursively: false,
        },
      ],
    },
  },
});

export default config;
