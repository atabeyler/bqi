import js from '@eslint/js';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';

export default [
  { ignores: ['dist/**', 'node_modules/**'] },
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: {
        window: 'readonly',
        document: 'readonly',
        navigator: 'readonly',
        console: 'readonly',
        localStorage: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
        Blob: 'readonly',
        FormData: 'readonly',
        RTCPeerConnection: 'readonly',
        RTCSessionDescription: 'readonly',
        RTCIceCandidate: 'readonly',
        MediaRecorder: 'readonly',
        SpeechSynthesisUtterance: 'readonly',
        CustomEvent: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        queueMicrotask: 'readonly',
        atob: 'readonly',
        btoa: 'readonly',
        import: 'readonly',
        Notification: 'readonly',
        FileReader: 'readonly',
        alert: 'readonly',
        confirm: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        __APP_VERSION__: 'readonly',
        URLSearchParams: 'readonly',
        sessionStorage: 'readonly',
        Element: 'readonly',
        File: 'readonly',
        crypto: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        BroadcastChannel: 'readonly',
        self: 'readonly',
        caches: 'readonly',
      },
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      // Note: eslint-plugin-react-hooks v7's "recommended" set also includes rules
      // specific to the React Compiler (purity/refs/immutability etc). This project
      // doesn't use the React Compiler, and those rules produce a lot of false
      // positives on otherwise solid code — so we only keep the two classic rules
      // that catch real bugs.
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'off',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // The codebase intentionally uses silent-catch for best-effort operations
      // like voice/notifications — this rule allows that pattern.
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
  {
    // Runs in the Service Worker global scope (no window/document), not the
    // page scope the block above is configured for.
    files: ['public/sw.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: {
        self: 'readonly',
        caches: 'readonly',
        fetch: 'readonly',
      },
    },
  },
];
