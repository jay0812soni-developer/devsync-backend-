import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';
import {
  getUserByEmailFromStore,
  saveUserInStore,
  getDeviceFromStore,
  savePairedConnectionInStore,
} from '../../lib/redis';
import { PairedConnection } from '../../lib/types';

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
    const { email, deviceId } = req.body || {};

    if (!email) {
      return res.status(400).json({ error: 'Email is required to regenerate connection code' });
    }

    const user = await getUserByEmailFromStore(email.trim());
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    const newCode = crypto.randomInt(100000, 1000000).toString();
    user.connectionCode = newCode;
    user.updatedAt = Date.now();
    await saveUserInStore(user);

    // Also update or re-link pairing record
    const device = await getDeviceFromStore(deviceId || user.primaryDeviceId);
    if (device) {
      const pair: PairedConnection = {
        connectionCode: newCode,
        primaryDevice: device,
        createdAt: Date.now(),
      };
      await savePairedConnectionInStore(pair);
    }

    return res.status(200).json({
      success: true,
      message: 'Connection code successfully rotated',
      connectionCode: newCode,
    });
  } catch (err: any) {
    console.error('Error in regenerate-code:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
