import crypto from 'crypto';

// Secret salt for stateless HMAC-based OTP and Connection Code derivation
const OTP_SECRET =
  process.env.OTP_SECRET ||
  process.env.SMTP_PASS ||
  'devsync-stateless-otp-salt-secret-key-2026';

// 5 minutes per window step
const WINDOW_MS = 5 * 60 * 1000;

/**
 * Generates a 6-digit Time-based One-Time Password (TOTP) bound to the email and time window.
 * This guarantees verification succeeds even across isolated serverless container instances.
 */
export function generateTotp(email: string, windowOffset: number = 0): string {
  const normalizedEmail = email.toLowerCase().trim();
  const currentWindow = Math.floor(Date.now() / WINDOW_MS) + windowOffset;

  const hmac = crypto.createHmac('sha256', OTP_SECRET);
  hmac.update(`${normalizedEmail}:${currentWindow}`);
  const digest = hmac.digest();

  // Extract a 6-digit number between 100000 and 999999
  const code = (digest.readUInt32BE(0) % 900000) + 100000;
  return code.toString();
}

/**
 * Validates a candidate 6-digit OTP against current and previous time windows (15 minutes total).
 */
export function verifyTotp(email: string, candidateOtp: string): boolean {
  if (!candidateOtp || candidateOtp.toString().trim().length !== 6) {
    return false;
  }

  const cleanOtp = candidateOtp.toString().trim();

  // Allow current window (0-5 min), previous window (5-10 min), window -2 (10-15 min), and slight forward clock skew (+1)
  const allowedOffsets = [0, -1, -2, 1];

  for (const offset of allowedOffsets) {
    const expected = generateTotp(email, offset);
    if (expected === cleanOtp) {
      return true;
    }
  }

  return false;
}

/**
 * Derives a deterministic 6-digit Connection Code for a user account if Redis is unavailable.
 * Guarantees that the device keeps the same pairing code across container restarts.
 */
export function getDeterministicConnectionCode(email: string): string {
  const normalizedEmail = email.toLowerCase().trim();
  const hmac = crypto.createHmac('sha256', OTP_SECRET);
  hmac.update(`devsync:conn:${normalizedEmail}`);
  const digest = hmac.digest();

  const code = (digest.readUInt32BE(0) % 900000) + 100000;
  return code.toString();
}
