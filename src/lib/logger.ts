import fs from 'node:fs'
import path from 'node:path'
import { config } from './config'
import { describeError } from './errors'
import { toBusinessDate } from './time'

/**
 * Logger sederhana: console + file harian di data/logs/.
 *
 * File log wajib ada karena di laptop toko jendela terminal sering tertutup —
 * tanpa file, error yang dilaporkan karyawan tidak bisa ditelusuri sama sekali.
 *
 * Kegagalan menulis log TIDAK boleh menjatuhkan aplikasi. Disk penuh berarti
 * log hilang, bukan toko berhenti jualan.
 */

type Level = 'info' | 'warn' | 'error'

const LOG_RETENTION_DAYS = 14

let dirReady = false

function ensureDir(): boolean {
  if (dirReady) return true
  try {
    fs.mkdirSync(config.paths.logs, { recursive: true })
    dirReady = true
    return true
  } catch {
    return false
  }
}

function logFilePath(now: Date): string {
  const date = toBusinessDate(now, config.timezone)
  return path.join(config.paths.logs, `app-${date.replace(/-/g, '')}.log`)
}

function writeLine(level: Level, scope: string, message: string, meta?: unknown): void {
  const now = new Date()
  const stamp = now.toISOString()
  const metaPart = meta === undefined ? '' : ` ${safeJson(meta)}`
  const line = `${stamp} [${level.toUpperCase()}] [${scope}] ${message}${metaPart}`

  if (level === 'error') console.error(line)
  else if (level === 'warn') console.warn(line)
  else console.log(line)

  if (!ensureDir()) return
  try {
    fs.appendFileSync(logFilePath(now), `${line}\n`, 'utf8')
  } catch {
    // Sengaja diam di sini saja: console sudah menerima pesannya, dan melempar
    // dari logger akan menyembunyikan error asli yang sedang kita catat.
  }
}

function safeJson(value: unknown): string {
  try {
    // BigInt melempar di JSON.stringify, dan SQLite mengembalikan nilai PRAGMA
    // serta hasil SUM() sebagai BigInt. Tanpa replacer ini, baris log yang
    // memuatnya jatuh ke fallback String() dan tercetak "[object Object]" —
    // yaitu justru kehilangan informasi yang sedang kita coba catat.
    return JSON.stringify(value, (_key, v) => (typeof v === 'bigint' ? v.toString() : v))
  } catch {
    return String(value)
  }
}

export interface Logger {
  info(message: string, meta?: unknown): void
  warn(message: string, meta?: unknown): void
  error(message: string, error?: unknown, meta?: unknown): void
}

export function createLogger(scope: string): Logger {
  return {
    info: (message, meta) => writeLine('info', scope, message, meta),
    warn: (message, meta) => writeLine('warn', scope, message, meta),
    error: (message, error, meta) => {
      const detail = error === undefined ? message : `${message} :: ${describeError(error)}`
      writeLine('error', scope, detail, meta)
    },
  }
}

/** Hapus file log yang lebih tua dari retensi. Dipanggil saat startup. */
export function pruneLogs(now: Date): number {
  if (!ensureDir()) return 0
  const cutoff = now.getTime() - LOG_RETENTION_DAYS * 86_400_000
  let removed = 0
  try {
    for (const name of fs.readdirSync(config.paths.logs)) {
      if (!/^app-\d{8}\.log$/.test(name)) continue
      const full = path.join(config.paths.logs, name)
      try {
        if (fs.statSync(full).mtimeMs < cutoff) {
          fs.unlinkSync(full)
          removed++
        }
      } catch {
        // File yang tidak bisa dibaca/dihapus dilewati, bukan menghentikan prune.
      }
    }
  } catch {
    return removed
  }
  return removed
}
