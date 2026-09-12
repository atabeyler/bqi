import js from '@eslint/js';

export default [
  // ui/ is its own project (own package.json, own eslint config, own React
  // globals) -- linted separately via `npm run lint --prefix bci/ui`, not
  // swept up here. quantum/ is Python, not JS.
  {
    // test/fixtures/** are deliberately-vulnerable/deliberately-malformed
    // sample files fed to the scanner engine adapters under test (e.g. an
    // eval()-on-input CommonJS fixture for the Semgrep smoke test) -- not
    // part of the ESM project, and not meant to pass its lint rules.
    ignores: ['node_modules/**', 'dist/**', 'quantum/**', 'ui/**', 'test/fixtures/**'],
  },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        setTimeout: 'readonly',
        setInterval: 'readonly',
        setImmediate: 'readonly',
        clearTimeout: 'readonly',
        clearInterval: 'readonly',
        global: 'writable',
        fetch: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        Response: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
];
