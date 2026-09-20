import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Modul murni tidak butuh setup apa pun. Integration test yang memakai
    // SQLite temp file membuat filenya sendiri per test file.
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // Lihat tests/stubs/server-only.ts: paket aslinya melempar saat dimuat di
      // luar bundler Next.js, sehingga modul server tidak bisa diuji sama sekali.
      // Penjaganya tetap berlaku saat `next build`.
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
})
