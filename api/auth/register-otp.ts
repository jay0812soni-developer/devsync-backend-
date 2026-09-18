import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import { storeOtp } from '../../lib/redis';
import { sendOtpEmail } from '../../lib/email';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { email, phone, name } = req.body || {};

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email address is required' });
    }

    if (!phone || typeof phone !== 'string' || phone.trim().length < 6) {
      return res.status(400).json({ error: 'Valid mobile number is required' });
    }

    // Generate secure 6-digit OTP
    const otp = crypto.randomInt(100000, 1000000).toString();

    // Store in Redis / memory with 10 minute (600s) expiration
    await storeOtp(email.trim(), phone.trim(), otp, 600);

    // Send dark-mode DevSync email via Nodemailer
    const emailResult = await sendOtpEmail(email.trim(), otp, name || 'Developer');

    if (!emailResult.success) {
      console.warn(`[Warning] Email sending failed: ${emailResult.error}. Providing fallback in dev/test.`);
      // In case of SMTP network issues, return OTP in response for fallback testing
      return res.status(200).json({
        success: true,
        message: 'OTP generated (email delivery delayed or in test mode)',
        email: email.trim(),
        warning: emailResult.error,
        // Only return debug OTP if SMTP had an issue to prevent developer lockout
        debugOtp: otp,
      });
    }

    return res.status(200).json({
      success: true,
      message: `6-digit verification code sent to ${email.trim()}`,
      email: email.trim(),
    });
  } catch (err: any) {
    console.error('Error generating register OTP:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
