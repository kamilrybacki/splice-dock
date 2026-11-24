// eslint.config.js
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

// Backend-specific SQL belongs behind the SqlDb contract and in adapters.
// Matching on the AST means comments never count.
const BACKEND_SQL = '/FOR UPDATE|SKIP LOCKED|pg_advisory|hashtextextended/';
const BACKEND_MESSAGE =
  'Backend-specific code does not belong in the service core: keep it behind the SqlDb contract, in an adapter.';

export const coreRestrictedSyntax = [
  { selector: `Literal[value=${BACKEND_SQL}]`, message: BACKEND_MESSAGE },
  { selector: `TemplateElement[value.raw=${BACKEND_SQL}]`, message: BACKEND_MESSAGE },
  { selector: 'Identifier[name=/isPostgres/]', message: BACKEND_MESSAGE },
  { selector: "MemberExpression[property.name='dialect']", message: BACKEND_MESSAGE },
  { selector: "MemberExpression[computed=true][property.value='dialect']", message: BACKEND_MESSAGE },
  { selector: "ObjectPattern > Property[key.name='dialect']", message: BACKEND_MESSAGE },
  {
    selector: "ImportExpression:not([source.type='Literal'])",
    message: 'Dynamic import() in the core needs a string literal so the layer rules can see it.',
  },
];

const PROCESS_MESSAGE =
  'The core may not touch process: map the environment onto config in the composition root (src/*.ts).';

// Everything below src/ except root files (src/*.ts) and adapters, so a file in
// an unexpected place is checked rather than skipped.
export const coreFiles = ['src/*/**/*.{ts,mts,cts,tsx}'];
export const coreIgnores = ['src/services/*/adapters/**'];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': 'error',
    },
  },
  {
    // Layer rules for the core. Package and relative-import rules live in
    // .dependency-cruiser.cjs; see docs/architecture.md.
    files: coreFiles,
    ignores: coreIgnores,
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'process', message: PROCESS_MESSAGE },
        // Banned outright so that aliasing (`const g = globalThis; g.process`)
        // and casts (`(globalThis as any).process`) cannot reach process.
        { name: 'globalThis', message: PROCESS_MESSAGE },
        { name: 'global', message: PROCESS_MESSAGE },
      ],
      'no-restricted-properties': [
        'error',
        { object: 'globalThis', property: 'process', message: PROCESS_MESSAGE },
        { object: 'global', property: 'process', message: PROCESS_MESSAGE },
      ],
      'no-restricted-syntax': ['error', ...coreRestrictedSyntax],
    },
  },
);
