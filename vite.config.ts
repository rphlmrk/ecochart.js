import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: 'src/index.ts',
      name: 'EcoChart',
      fileName: (format) => `ecochart.${format}.js`
    },
    rollupOptions: {
      // Keep dependencies bundled inside so the user just imports one file
      external: [], 
    }
  }
});