import { defineConfig } from 'vitest/config';

// Exporter tests only; the dashboard in web/ has its own vitest setup.
export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
});
