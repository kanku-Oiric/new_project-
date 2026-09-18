/**
 * Konstanta PIN yang aman diimpor dari client component.
 *
 * Dipisah dari `pin.ts` dengan sengaja: file itu mengimpor `bcryptjs` dan
 * `node:crypto`, dan menariknya ke bundle browser akan gagal build sekaligus
 * membawa kode hashing ke tempat yang tidak membutuhkannya.
 */
export const PIN_MIN_LENGTH = 4
export const PIN_MAX_LENGTH = 6
