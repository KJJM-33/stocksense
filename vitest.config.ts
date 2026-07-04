import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['lib/engine/__tests__/**/*.test.ts'],
    globals: false,
  },
  resolve: {
    alias: {
      // Allow .js extension imports to resolve to .ts source files
      // (TypeScript uses .js extensions in imports for ESM compatibility)
    },
    extensions: ['.ts', '.tsx', '.js', '.jsx'],
  },
});
