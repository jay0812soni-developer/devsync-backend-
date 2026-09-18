import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import {
  fetchOtp,
  removeOtp,
  getUserByEmailFromStore,
  saveUserInStore,
  registerDeviceInStore,
  savePairedConnectionInStore,
} from '../../lib/redis';
import { DeviceRegistration, UserAccount, PairedConnection } from '../../lib/types';

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
    const { email, otp, device } = req.body || {};

    if (!email || !otp) {
      return res.status(400).json({ error: 'Email and 6-digit OTP are required' });
    }

    const storedOtpRecord = await fetchOtp(email.trim());

    if (!storedOtpRecord) {
      return res.status(400).json({ error: 'Invalid or expired OTP. Please request a new code.' });
    }

    if (storedOtpRecord.otp !== otp.toString().trim()) {
      storedOtpRecord.attempts += 1;
      if (storedOtpRecord.attempts >= 5) {
        await removeOtp(email.trim());
        return res.status(400).json({ error: 'Too many incorrect attempts. Please request a new OTP.' });
      }
      return res.status(400).json({ error: 'Incorrect OTP. Please check the code in your email.' });
    }

    // OTP is valid! Purge it to prevent replay attacks
    await removeOtp(email.trim());

    // Check if user already has an account
    let user = await getUserByEmailFromStore(email.trim());

    if (!user) {
      // Generate a persistent 6-digit Connection Code for this user
      const code = crypto.randomInt(100000, 1000000).toString();
      user = {
        email: email.trim(),
        phone: storedOtpRecord.phone,
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
    }

    return res.status(200).json({
      success: true,
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
