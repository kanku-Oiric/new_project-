import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { FlatCompat } from '@eslint/eslintrc'

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
})

const config = [
  {
    ignores: [
      '.next/**',
      // Folder build terpisah milik tests/api-http.test.ts (NEXT_DIST_DIR).
      '.next-test/**',
      'node_modules/**',
      'data/**',
      'backups/**',
      'prisma/migrations/**',
      'next-env.d.ts',
    ],
  },
  ...compat.extends('next/core-web-vitals', 'next/typescript'),
  {
    rules: {
      // Larangan `any` sembarangan dari docs/architecture.md §3.1 ditegakkan di
      // sini, bukan hanya disepakati.
      '@typescript-eslint/no-explicit-any': 'error',
      // Exception yang ditelan diam-diam adalah salah satu larangan utama.
      // Blok catch kosong harus punya komentar penjelas, jadi aturannya
      // dinyalakan dan pengecualian ditulis eksplisit per kasus.
      'no-empty': ['error', { allowEmptyCatch: true }],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
]

export default config
