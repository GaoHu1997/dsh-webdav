import { defineConfig } from 'vitest/config'

export default defineConfig({
  esbuild: { jsx: 'automatic' },
  test: {
    include: ['tests/**/*.spec.{ts,tsx}'],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    // The relay suites drive real loopback sockets and a real upstream server:
    // one round trip costs ~0.3-0.5s on a slow Windows box, so the heaviest of
    // them lands right on top of the 5s default. See docs/decisions/0051.
    testTimeout: 20_000,
    // The client suites import host UI packages whose lib pulls .module.css;
    // left external, Node itself would choke on the extension.
    server: {
      deps: {
        inline: [/@deepseek-ai\//],
      },
    },
  },
})
