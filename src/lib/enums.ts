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
export type ManualStockReason = z.infer<typeof ManualStockReasonSchema>

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

/**
 * `CASH_OUT` bukan cara membayar — ia cara toko MENYERAHKAN uang, dipakai
 * transaksi tarik tunai yang nilainya negatif bagi laci. Ia berdiri di daftar
 * yang sama supaya satu transaksi tetap punya tepat satu baris pembayaran dan
 * state machine yang sama; yang membedakannya hanya arah uangnya.
 *
 * `Payment.amount` untuk CASH_OUT tetap POSITIF (= uang yang diserahkan).
 * Menyimpannya negatif akan menabrak assertRupiah di modul kas.
 */
export const PAYMENT_METHODS = ['CASH', 'QRIS_STATIC', 'CASH_OUT'] as const
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

// ─────────────────────────────── JASA PEMBAYARAN ───────────────────────────────

export const SERVICE_KINDS = [
  'TOKEN_LISTRIK',
  'PLN_PASCABAYAR',
  'PDAM',
  'EWALLET_TOPUP',
  'TRANSFER_BANK',
  'TARIK_TUNAI',
] as const
export const ServiceKindSchema = z.enum(SERVICE_KINDS)
export type ServiceKind = z.infer<typeof ServiceKindSchema>

/**
 * Arah uang, dan ini yang membedakan tarik tunai dari lima jasa lainnya.
 *
 * PROVIDER_OUT  pelanggan menyerahkan uang, saldo provider BERKURANG
 *               (token listrik, PLN, PDAM, top-up e-wallet, transfer bank)
 * PROVIDER_IN   pelanggan transfer ke rekening toko, saldo provider BERTAMBAH,
 *               dan toko menyerahkan uang tunai (tarik tunai)
 */
export const SERVICE_DIRECTIONS = ['PROVIDER_OUT', 'PROVIDER_IN'] as const
export const ServiceDirectionSchema = z.enum(SERVICE_DIRECTIONS)
export type ServiceDirection = z.infer<typeof ServiceDirectionSchema>

export const PROVIDER_KINDS = ['EWALLET', 'BANK', 'PPOB'] as const
export const ProviderKindSchema = z.enum(PROVIDER_KINDS)
export type ProviderKind = z.infer<typeof ProviderKindSchema>

export const PROVIDER_MOVEMENT_REASONS = [
  'INITIAL',
  'TOPUP',
  'SERVICE',
  'SERVICE_FAILED',
  'ADJUSTMENT',
] as const
export const ProviderMovementReasonSchema = z.enum(PROVIDER_MOVEMENT_REASONS)
export type ProviderMovementReason = z.infer<typeof ProviderMovementReasonSchema>

/** Alasan yang boleh dipilih manusia lewat halaman saldo. */
export const MANUAL_PROVIDER_REASONS = ['TOPUP', 'ADJUSTMENT'] as const
export const ManualProviderReasonSchema = z.enum(MANUAL_PROVIDER_REASONS)
export type ManualProviderReason = z.infer<typeof ManualProviderReasonSchema>

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
  'PROVIDER_CREATE',
  'PROVIDER_UPDATE',
  'PROVIDER_TOPUP',
  'PROVIDER_ADJUSTMENT',
  'PRODUCT_DELETE',
  'SETTING_CHANGE',
  'USER_CREATE',
  'USER_UPDATE',
  'BACKUP_RUN',
  'REPORT_SEND_MANUAL',
  'AI_INSIGHT_REQUEST',
] as const
export const AuditActionSchema = z.enum(AUDIT_ACTIONS)
export type AuditAction = z.infer<typeof AuditActionSchema>
