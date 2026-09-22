import { test } from 'node:test';
import assert from 'node:assert';
import crypto from 'crypto';

const OTP_SECRET = 'devsync-stateless-otp-salt-secret-key-2026';
const WINDOW_MS = 5 * 60 * 1000;

function generateTotp(email, windowOffset = 0) {
  const normalizedEmail = email.toLowerCase().trim();
  const currentWindow = Math.floor(Date.now() / WINDOW_MS) + windowOffset;
  const hmac = crypto.createHmac('sha256', OTP_SECRET);
  hmac.update(`${normalizedEmail}:${currentWindow}`);
  const digest = hmac.digest();
  const code = (digest.readUInt32BE(0) % 900000) + 100000;
  return code.toString();
}

function verifyTotp(email, candidateOtp) {
  if (!candidateOtp || candidateOtp.toString().trim().length !== 6) return false;
  const cleanOtp = candidateOtp.toString().trim();
  const allowedOffsets = [0, -1, -2, 1];
  for (const offset of allowedOffsets) {
    if (generateTotp(email, offset) === cleanOtp) return true;
  }
  return false;
}

test('generateTotp returns 6-digit string', () => {
  const code = generateTotp('user@example.com');
  assert.strictEqual(typeof code, 'string');
  assert.strictEqual(code.length, 6);
  assert.match(code, /^[0-9]{6}$/);
});

test('verifyTotp verifies valid code for matching email', () => {
  const email = 'akhil2006prajapati@gmail.com';
  const code = generateTotp(email);
  assert.strictEqual(verifyTotp(email, code), true);
});

test('verifyTotp rejects incorrect code', () => {
  const email = 'akhil2006prajapati@gmail.com';
  assert.strictEqual(verifyTotp(email, '000000'), false);
});

test('verifyTotp rejects valid code for a different email', () => {
  const code = generateTotp('user1@example.com');
  assert.strictEqual(verifyTotp('user2@example.com', code), false);
});

test('verifyTotp accepts codes within 15-minute window', () => {
  const email = 'akhil2006prajapati@gmail.com';
  const code5minAgo = generateTotp(email, -1);
  const code10minAgo = generateTotp(email, -2);
  assert.strictEqual(verifyTotp(email, code5minAgo), true);
  assert.strictEqual(verifyTotp(email, code10minAgo), true);
});

test('verifyTotp rejects expired codes older than 15 minutes', () => {
  const email = 'akhil2006prajapati@gmail.com';
  const expiredCode = generateTotp(email, -3);
  assert.strictEqual(verifyTotp(email, expiredCode), false);
});
