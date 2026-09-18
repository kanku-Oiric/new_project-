import type { Prisma, PrismaClient } from '@prisma/client'
import type { AuditAction, Role } from './enums'
import { prisma } from './db/prisma'

/**
 * Audit log — append-only secara desain.
 *
 * Tidak ada fungsi update maupun delete di file ini, dan tidak ada endpoint
 * untuk keduanya. Kasir tidak bisa menghapus jejak karena jalurnya memang tidak
 * pernah dibuat, bukan karena tombolnya disembunyikan.
 */

/** Client Prisma atau transaction client — audit harus bisa ikut di dalam $transaction. */
export type Db = PrismaClient | Prisma.TransactionClient

export interface AuditActor {
  userId: string | null
  role: Role | null
  ip?: string | null
  deviceLabel?: string | null
}

export interface AuditInput {
  action: AuditAction
  summary: string
  entityType?: string
  entityId?: string
  before?: unknown
  after?: unknown
}

function serialize(value: unknown): string | null {
  if (value === undefined) return null
  try {
    return JSON.stringify(value)
  } catch {
    return JSON.stringify({ unserializable: String(value) })
  }
}

/**
 * Catat satu peristiwa. Terima `db` supaya pemanggil di dalam DB transaction
 * bisa meneruskan tx-nya — audit untuk checkout, void, dan refund HARUS
 * ter-rollback bersama operasinya kalau ada langkah yang gagal, bukan tertinggal
 * sebagai catatan peristiwa yang sebenarnya tidak pernah terjadi.
 */
export async function recordAudit(
  db: Db,
  actor: AuditActor,
  input: AuditInput,
): Promise<void> {
  await db.auditLog.create({
    data: {
      userId: actor.userId,
      actorRole: actor.role,
      action: input.action,
      entityType: input.entityType ?? null,
      entityId: input.entityId ?? null,
      summary: input.summary,
      beforeJson: serialize(input.before),
      afterJson: serialize(input.after),
      ip: actor.ip ?? null,
      deviceLabel: actor.deviceLabel ?? null,
    },
  })
}

/**
 * Untuk peristiwa di luar transaction bisnis (login, backup). Kegagalan menulis
 * audit di sini tidak boleh menggagalkan aksi utamanya — login yang berhasil
 * tetap berhasil walaupun barisnya gagal tercatat.
 */
export async function recordAuditSafe(actor: AuditActor, input: AuditInput): Promise<void> {
  try {
    await recordAudit(prisma, actor, input)
  } catch {
    // Sengaja tidak melempar. Dicatat oleh pemanggil kalau perlu.
  }
}
