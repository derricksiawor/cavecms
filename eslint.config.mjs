import { FlatCompat } from '@eslint/eslintrc'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const compat = new FlatCompat({ baseDirectory: __dirname })

const config = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'db/migrations/**',
      'scripts/server-only-shim/**',
      'next-env.d.ts',
      'public/**',
      // Local safe-delete workflow moves files to .trash-<unix-ts>/
      // instead of rm. Gitignored; must never be linted (typically
      // holds stale .next build output captured by `mv .next ...`).
      '.trash-*/**',
      // Separate workspace package — CommonJS Node script with its own
      // package.json + lockfile. The app's TS/ESM lint rules don't
      // apply (require() is correct here, not a violation), and the
      // bundle gets `pnpm install --prod --filter=migrator` in CI so
      // its dependencies are intentionally tracked separately.
      'migrator/**',
    ],
  },
  ...compat.config({
    extends: ['next/core-web-vitals', 'next/typescript'],
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-explicit-any': 'error',
    },
  }),
]

export default config
