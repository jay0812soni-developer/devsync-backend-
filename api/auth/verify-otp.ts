import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import {
  fetchOtp,
  removeOtp,
  getUserByEmailFromStore,
  saveUserInStore,
  registerDeviceInStore,
  savePairedConnectionInStore,
  addDeviceToGroup,
  markOtpUsed,
  isOtpUsed,
} from '../../lib/redis';
import { DeviceRegistration, UserAccount, PairedConnection } from '../../lib/types';
import { verifyTotp, getDeterministicConnectionCode } from '../../lib/totp';

const JWT_SECRET = process.env.JWT_SECRET || 'devsync-mesh-jwt-secret-audit-key-2026';

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
    const rawBody = req.body || {};
    const { email, otp, phone } = rawBody;
    const device = rawBody.device || (rawBody.deviceId ? {
      deviceId: rawBody.deviceId,
      deviceName: rawBody.deviceName,
      platform: rawBody.platform,
      signingPublicKey: rawBody.signingPublicKey,
      exchangePublicKey: rawBody.exchangePublicKey,
      lanIp: rawBody.lanIp,
      lanPort: rawBody.lanPort,
    } : null);

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and 6-digit OTP are required' });
    }

    const cleanEmail = email.toString().trim();
    const cleanOtp = otp.toString().trim();

    if (cleanOtp.length !== 6) {
      return res.status(400).json({ error: 'Verification code must be exactly 6 digits' });
    }

    // Check if OTP was already consumed
    if (await isOtpUsed(cleanEmail, cleanOtp)) {
      return res.status(400).json({ error: 'This verification code has already been used. Please request a new code.' });
    }

    // 1. Try fetching from store (Redis / memory)
    const storedOtpRecord = await fetchOtp(cleanEmail);

    let isOtpValid = false;

    if (storedOtpRecord && storedOtpRecord.otp === cleanOtp) {
      isOtpValid = true;
    } else if (verifyTotp(cleanEmail, cleanOtp)) {
      // Stateless TOTP fallback: guarantees verification across isolated serverless instances
      isOtpValid = true;
    }

    if (!isOtpValid) {
      if (storedOtpRecord) {
        storedOtpRecord.attempts = (storedOtpRecord.attempts || 0) + 1;
        if (storedOtpRecord.attempts >= 5) {
          await removeOtp(cleanEmail);
          return res.status(400).json({ error: 'Too many incorrect attempts. Please request a new OTP.' });
        }
      }
      return res.status(400).json({ error: 'Incorrect or expired OTP. Please check the code in your email (and Spam folder).' });
    }

    // OTP is valid! Mark as consumed and purge from store
    await markOtpUsed(cleanEmail, cleanOtp);
    await removeOtp(cleanEmail);

    // Check if user already has an account
    let user = await getUserByEmailFromStore(cleanEmail);

    if (!user) {
      // Use deterministic code or persistent store
      const code = getDeterministicConnectionCode(cleanEmail);
      user = {
        email: cleanEmail,
        phone: phone?.toString().trim() || storedOtpRecord?.phone || '',
        primaryDeviceId: device?.deviceId || 'device-primary',
        connectionCode: code,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      await saveUserInStore(user);
    }

    // If device information is provided, register it in the store
    if (device && device.deviceId) {
      const devReg: DeviceRegistration = {
        deviceId: device.deviceId,
        deviceName: device.deviceName || 'DevSync Device',
        platform: device.platform || 'unknown',
        signingPublicKey: device.signingPublicKey || '',
        exchangePublicKey: device.exchangePublicKey || '',
        lanIp: device.lanIp,
        lanPort: device.lanPort,
        timestamp: Date.now(),
      };
      await registerDeviceInStore(devReg);

      // Create initial pairing connection entry
      const pair: PairedConnection = {
        connectionCode: user.connectionCode,
        primaryDevice: devReg,
        createdAt: Date.now(),
      };
      await savePairedConnectionInStore(pair);

      // Register primary device in group devices registry
      await addDeviceToGroup(user.connectionCode, devReg, true);
    }

    const token = jwt.sign(
      {
        email: user.email,
        deviceId: device?.deviceId || user.primaryDeviceId || 'device-primary',
        connectionCode: user.connectionCode,
        role: 'PRIMARY',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.status(200).json({
      success: true,
      token,
      message: 'Authentication successful',
      user: {
        email: user.email,
        phone: user.phone,
        connectionCode: user.connectionCode,
      },
      connectionCode: user.connectionCode,
    });
  } catch (err: any) {
    console.error('Error in verify-otp:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
