import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Relative asset paths, so the build works both at the site root and under
  // GitHub Pages' /track_layout/ sub-path.
  base: './',
  test: { environment: 'node' },
});
