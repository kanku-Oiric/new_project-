import { z } from 'zod'

/**
 * SQLite + Prisma tidak mendukung `enum`, jadi semua status disimpan sebagai
 * String. File ini adalah SATU-SATUNYA sumber kebenaran untuk nilai-nilai itu:
 * Zod schema untuk validasi runtime, dan tipe TypeScript yang diturunkan
 * darinya. Tidak ada tempat lain yang boleh menuliskan literal status.
 *
 * Referensi: docs/database.md §1.1
 */

// ─────────────────────────────── USER ───────────────────────────────

export const ROLES = ['OWNER', 'CASHIER'] as const
export const RoleSchema = z.enum(ROLES)
export type Role = z.infer<typeof RoleSchema>

// ─────────────────────────────── STOK ───────────────────────────────

export const STOCK_REASONS = [
  'SALE',
  'REFUND',
  'VOID',
  'PURCHASE',
  'ADJUSTMENT',
  'OPNAME',
  'INITIAL',
] as const
export const StockReasonSchema = z.enum(STOCK_REASONS)
export type StockReason = z.infer<typeof StockReasonSchema>

export const STOCK_REF_TYPES = ['TRANSACTION', 'REFUND', 'PURCHASE', 'MANUAL'] as const
export const StockRefTypeSchema = z.enum(STOCK_REF_TYPES)
export type StockRefType = z.infer<typeof StockRefTypeSchema>

/** Alasan yang boleh dipilih manusia lewat form penyesuaian stok. */
export const MANUAL_STOCK_REASONS = ['ADJUSTMENT', 'OPNAME'] as const
export const ManualStockReasonSchema = z.enum(MANUAL_STOCK_REASONS)

// ─────────────────────────────── SHIFT ───────────────────────────────

export const SHIFT_STATUSES = ['OPEN', 'CLOSED'] as const
export const ShiftStatusSchema = z.enum(SHIFT_STATUSES)
export type ShiftStatus = z.infer<typeof ShiftStatusSchema>

// ─────────────────────────────── TRANSAKSI ───────────────────────────────

export const TRANSACTION_STATUSES = ['PENDING', 'COMPLETED', 'VOIDED', 'CANCELLED'] as const
export const TransactionStatusSchema = z.enum(TRANSACTION_STATUSES)
export type TransactionStatus = z.infer<typeof TransactionStatusSchema>

/**
 * Hanya transaksi COMPLETED yang masuk perhitungan penjualan.
 * docs/reporting.md §5.1 — VOIDED, CANCELLED, dan PENDING semuanya dikecualikan.
 */
export const SALES_COUNTED_STATUSES = ['COMPLETED'] as const

// ─────────────────────────────── PEMBAYARAN ───────────────────────────────

export const PAYMENT_METHODS = ['CASH', 'QRIS_STATIC'] as const
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS)
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>

export const PAYMENT_STATUSES = ['PENDING', 'PAID', 'EXPIRED', 'CANCELLED', 'FAILED'] as const
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES)
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>

/** State terminal — tidak ada transisi keluar. docs/qris.md §4 */
export const TERMINAL_PAYMENT_STATUSES = ['PAID', 'EXPIRED', 'CANCELLED', 'FAILED'] as const

// ─────────────────────────────── REFUND & PENGELUARAN ───────────────────────────────

export const REFUND_METHODS = ['CASH', 'QRIS_MANUAL', 'OTHER'] as const
export const RefundMethodSchema = z.enum(REFUND_METHODS)
export type RefundMethod = z.infer<typeof RefundMethodSchema>

export const EXPENSE_SOURCES = ['CASH_DRAWER', 'OTHER'] as const
export const ExpenseSourceSchema = z.enum(EXPENSE_SOURCES)
export type ExpenseSource = z.infer<typeof ExpenseSourceSchema>

// ─────────────────────────────── LAPORAN ───────────────────────────────

export const REPORT_KINDS = ['DAILY', 'WEEKLY', 'MONTHLY'] as const
export const ReportKindSchema = z.enum(REPORT_KINDS)
export type ReportKind = z.infer<typeof ReportKindSchema>

export const REPORT_CHANNELS = ['DISCORD', 'TELEGRAM'] as const
export const ReportChannelSchema = z.enum(REPORT_CHANNELS)
export type ReportChannel = z.infer<typeof ReportChannelSchema>

export const REPORT_TRIGGERS = ['AUTO', 'MANUAL'] as const
export const ReportTriggerSchema = z.enum(REPORT_TRIGGERS)
export type ReportTrigger = z.infer<typeof ReportTriggerSchema>

export const DELIVERY_STATUSES = ['PENDING', 'SENT', 'FAILED'] as const
export const DeliveryStatusSchema = z.enum(DELIVERY_STATUSES)
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>

// ─────────────────────────────── AUDIT ───────────────────────────────

export const AUDIT_ACTIONS = [
  'LOGIN',
  'LOGIN_FAILED',
  'LOGOUT',
  'SHIFT_OPEN',
  'SHIFT_CLOSE',
  'PENDING_CANCELLED_ON_SHIFT_CLOSE',
  'PAYMENT_CONFIRM',
  'PAYMENT_CANCEL',
  'VOID',
  'REFUND',
  'PRICE_CHANGE',
  'COST_CHANGE',
  'PURCHASE_RECEIVED',
  'PRODUCT_CREATE',
  'PRODUCT_UPDATE',
  'STOCK_ADJUSTMENT',
  'EXPENSE_DELETE',
  'SETTING_CHANGE',
  'USER_CREATE',
  'USER_UPDATE',
  'BACKUP_RUN',
  'REPORT_SEND_MANUAL',
  'AI_INSIGHT_REQUEST',
] as const
export const AuditActionSchema = z.enum(AUDIT_ACTIONS)
export type AuditAction = z.infer<typeof AuditActionSchema>
