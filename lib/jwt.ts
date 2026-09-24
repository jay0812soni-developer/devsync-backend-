import jwt from 'jsonwebtoken';

/**
 * Shared JWT session layer for DevSync.
 *
 * SECURITY: JWT_SECRET must be provided via environment variable.
 * There is intentionally NO hardcoded fallback: tokens issued by one layer
 * must verify in every other layer, and default secrets are an attacker gift.
 */
/**
 * Resolves lazily (not at import time) so test harnesses can set the env var
 * in before() hooks, and so importing the module never crashes a cold start
 * for a route that does not need auth.
 */
function secret(): string {
  const value = process.env.JWT_SECRET;
  if (value) return value;

  // Hard requirement in production: no deployment may run on a default secret.
  if (process.env.VERCEL_ENV === 'production' || process.env.NODE_ENV === 'production') {
    throw new Error(
      'JWT_SECRET environment variable is required in production. ' +
        'Set it in Vercel project settings before deploying.'
    );
  }

  // Dev/test fallback so local runs and test harnesses work without setup.
  if (!warnedDevFallback) {
    warnedDevFallback = true;
    console.warn('[DevSync JWT] JWT_SECRET not set — using DEV fallback secret. NEVER deploy like this.');
  }
  return 'devsync-dev-only-jwt-secret-local-tests';
}

let warnedDevFallback = false;

export interface DevSyncJwtClaims {
  email: string;
  deviceId: string;
  connectionCode: string;
  role: 'PRIMARY' | 'MEMBER';
  userId?: string;
  groupId?: string;
  iat?: number;
  exp?: number;
}

/** Signs a session token with the standard DevSync claims. */
export function signSessionToken(
  claims: Omit<DevSyncJwtClaims, 'iat' | 'exp'>,
  expiresIn: string = '30d'
): string {
  return jwt.sign(claims, secret(), { expiresIn });
}

/** Verifies a Bearer token and returns its claims, or null if invalid. */
export function verifyBearerToken(authHeader: string | undefined | null): DevSyncJwtClaims | null {
  if (!authHeader || !authHeader.startsWith('Bearer ')) return null;
  const rawToken = authHeader.substring(7).trim();
  if (!rawToken) return null;
  try {
    return jwt.verify(rawToken, secret()) as DevSyncJwtClaims;
  } catch (_) {
    return null;
  }
}

/** Extracts claims from a raw token string (no Bearer prefix expected). */
export function verifyRawToken(rawToken: string): DevSyncJwtClaims | null {
  try {
    return jwt.verify(rawToken, secret()) as DevSyncJwtClaims;
  } catch (_) {
    return null;
  }
}

/** Standard 401 response helper for Vercel serverless handlers. */
export function unauthorized(res: any, message = 'Authentication required') {
  return res.status(401).json({ error: message });
}