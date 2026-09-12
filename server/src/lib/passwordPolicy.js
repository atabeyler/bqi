/**
 * Server-side password complexity policy for admin-created/updated accounts
 * (see routes/auth.js's POST/PATCH /admin/users). Previously only checked
 * length (>= 8) -- this adds the standard character-class requirements so
 * "12345678" no longer passes.
 */
const MIN_LENGTH = 8;
// bcrypt itself silently truncates at 72 bytes, so anything past that adds
// no real strength -- capped well below that (with room for multi-byte
// Turkish characters) mainly to reject a pathologically long payload that
// would otherwise still get hashed (CPU cost) for no security benefit.
const MAX_LENGTH = 128;

export function validatePassword(password) {
  if (typeof password !== 'string' || password.length < MIN_LENGTH) {
    return `Şifre en az ${MIN_LENGTH} karakter olmalı`;
  }
  if (password.length > MAX_LENGTH) {
    return `Şifre en fazla ${MAX_LENGTH} karakter olabilir`;
  }
  if (!/[a-z]/.test(password)) return 'Şifre en az bir küçük harf içermeli';
  if (!/[A-Z]/.test(password)) return 'Şifre en az bir büyük harf içermeli';
  if (!/[0-9]/.test(password)) return 'Şifre en az bir rakam içermeli';
  if (!/[^A-Za-z0-9]/.test(password)) return 'Şifre en az bir özel karakter içermeli (örn. !?#*_-)';
  return null;
}
