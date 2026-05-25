module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2022, sourceType: 'module', project: ['./tsconfig.json'] },
  plugins: ['@typescript-eslint'],
  extends: [
    'eslint:recommended',
    'plugin:@typescript-eslint/recommended-type-checked',
  ],
  rules: {
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    'no-console': ['error', { allow: ['error', 'warn'] }],
  },
  // frontend/ is a separate Vite sub-project with its own tsconfig; it lints itself.
  ignorePatterns: ['dist/', 'node_modules/', 'coverage/', '*.config.ts', 'scripts/', 'tests/', 'examples/', 'frontend/'],
};
