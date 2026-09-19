import { NotConfiguredError } from '../../errors'
import type { ProviderReadiness } from '../types'

/**
 * WhatsApp — STUB, dan akan tetap stub sampai ada jalur resmi.
 *
 * Library tidak resmi seperti Baileys bekerja dengan menyamar sebagai WhatsApp
 * Web. Nomor toko bisa diblokir permanen karenanya, dan nomor itu adalah nomor
 * yang dipakai pelanggan menghubungi toko. Itu bukan risiko yang pantas diambil
 * demi sebuah laporan harian yang sudah bisa dikirim lewat Discord atau Telegram.
 *
 * Jalur resminya adalah WhatsApp Business API lewat penyedia resmi, yang
 * berbayar dan butuh verifikasi bisnis. Kalau pemilik menempuh itu, provider ini
 * tinggal diimplementasikan seperti Discord/Telegram tanpa mengubah kode lain.
 *
 * Yang TIDAK dilakukan file ini: berpura-pura sedang dikembangkan, atau diam
 * saja saat dipanggil.
 */

export const WHATSAPP_NOT_CONFIGURED =
  'WhatsApp belum dikonfigurasi. Perlu WhatsApp Business API resmi — library tidak resmi tidak dipakai karena berisiko nomor toko diblokir.'

export function whatsappReadiness(): ProviderReadiness {
  return {
    configured: false,
    label: 'WhatsApp tidak tersedia',
    hint: WHATSAPP_NOT_CONFIGURED,
  }
}

export function sendWhatsApp(): never {
  throw new NotConfiguredError(WHATSAPP_NOT_CONFIGURED)
}
