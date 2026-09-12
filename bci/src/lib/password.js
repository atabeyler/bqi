import bcrypt from 'bcrypt';

const COST_FACTOR = 12;

export function hashPassword(plain) {
  return bcrypt.hash(plain, COST_FACTOR);
}

export function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}
