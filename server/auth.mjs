import { randomBytes, createHash, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { AppError } from './errors.mjs';

const derive = promisify(scrypt);
const tokenHash = (token) => createHash('sha256').update(token).digest('hex');
const cookieName = 'lt_session';

export async function passwordRecord(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = await derive(password, salt, 64);
  return { passwordSalt: salt, passwordHash: hash.toString('hex') };
}
export async function verifyPassword(password, user) {
  const hash = await derive(password, user?.password_salt || 'nonexistent-account-salt', 64);
  const expected = user ? Buffer.from(user.password_hash, 'hex') : Buffer.alloc(64);
  return timingSafeEqual(hash, expected) && Boolean(user);
}
function sessionToken(request) {
  const match = (request.headers.cookie || '').match(/(?:^|;\s*)lt_session=([a-f0-9]{64})(?:;|$)/);
  return match?.[1];
}
export function authenticate(repo, request) {
  const token = sessionToken(request);
  if (!token) return null;
  return repo.session(tokenHash(token))?.user_id || null;
}
export function requireUser(repo, request) {
  const userId = authenticate(repo, request);
  if (!userId) throw new AppError(401, 'AUTH_REQUIRED', 'Sign in to use your personal learning workspace.');
  return userId;
}
export function createSession(repo, userId, response, secure) {
  const token = randomBytes(32).toString('hex');
  const maxAge = 30 * 86400;
  repo.addSession(tokenHash(token), userId, new Date(Date.now() + maxAge * 1000).toISOString());
  response.setHeader('Set-Cookie', `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? '; Secure' : ''}`);
}
export function logout(repo, request, response, secure) {
  const token = sessionToken(request);
  if (token) repo.removeSession(tokenHash(token));
  response.setHeader('Set-Cookie', `${cookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`);
}

export class RateLimiter {
  constructor() { this.buckets = new Map(); }
  take(key, limit, windowMs) {
    const time = Date.now();
    for (const [id, bucket] of this.buckets) if (bucket.resetAt <= time) this.buckets.delete(id);
    const bucket = this.buckets.get(key) || { count: 0, resetAt: time + windowMs };
    if (bucket.count >= limit) throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Please try again later.');
    bucket.count++; this.buckets.set(key, bucket);
  }
}
