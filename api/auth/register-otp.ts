import type { VercelRequest, VercelResponse } from '@vercel/node';
import { storeOtp } from '../../lib/redis';
import { sendOtpEmail } from '../../lib/email';
import { generateTotp } from '../../lib/totp';

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

    const cleanEmail = email.trim();
    const cleanPhone = phone.trim();

    // Generate stateless, serverless-resilient 6-digit TOTP
    const otp = generateTotp(cleanEmail);

    // Also store in Redis / store (15 minute TTL)
    await storeOtp(cleanEmail, cleanPhone, otp, 900);

    // Send dark-mode DevSync email via Nodemailer
    const emailResult = await sendOtpEmail(cleanEmail, otp, name || 'Developer');

    if (!emailResult.success) {
      return res.status(500).json({
        success: false,
        error: `Failed to send verification email: ${emailResult.error || 'SMTP delivery error'}. Please try again.`,
      });
    }

    return res.status(200).json({
      success: true,
      message: `6-digit verification code sent to ${cleanEmail}. Please check your Inbox and Spam folder.`,
      email: cleanEmail,
    });
  } catch (err: any) {
    console.error('Error generating register OTP:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
