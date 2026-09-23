import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import {
  getUserByConnectionCodeFromStore,
  getPairedConnectionFromStore,
  savePairedConnectionInStore,
  registerDeviceInStore,
  enqueueMessageInStore,
  isRedisConfigured,
  getDeviceFromStore,
} from '../../lib/redis';
import { DeviceRegistration, PairedConnection, EncryptedMessagePayload } from '../../lib/types';

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
    const connectionCode = rawBody.connectionCode;
    const device = rawBody.device || (rawBody.deviceId ? {
      deviceId: rawBody.deviceId,
      deviceName: rawBody.deviceName,
      platform: rawBody.platform,
      signingPublicKey: rawBody.signingPublicKey,
      exchangePublicKey: rawBody.exchangePublicKey,
      lanIp: rawBody.lanIp,
      lanPort: rawBody.lanPort,
    } : null);

    if (!connectionCode || typeof connectionCode !== 'string') {
      return res.status(400).json({ error: '6-digit Connection Code is required' });
    }

    const cleanCode = connectionCode.replace(/[^0-9]/g, '').trim();
    if (cleanCode.length !== 6) {
      return res.status(400).json({ error: 'Connection Code must be exactly 6 digits' });
    }

    if (!device || !device.deviceId) {
      return res.status(400).json({ error: 'Device identity is required for pairing' });
    }

    // 1. Look up user by Connection Code
    const user = await getUserByConnectionCodeFromStore(cleanCode);
    const existingPair = await getPairedConnectionFromStore(cleanCode);

    if (!user && !existingPair) {
      if (!isRedisConfigured) {
        return res.status(404).json({
          error:
            'Connection Code not found across serverless instances. The backend is running in ephemeral mode (Redis not connected). Enable Vercel KV / Upstash Redis in your Vercel project Storage, scan the QR code directly, or tap "Login with Email".',
        });
      }
      return res.status(404).json({
        error: 'Invalid Connection Code. Make sure your primary device has registered and generated a code.',
      });
    }

    let primaryDevice = existingPair?.primaryDevice;
    if (!primaryDevice && user && user.primaryDeviceId) {
      const dev = await getDeviceFromStore(user.primaryDeviceId);
      if (dev) {
        primaryDevice = dev;
      }
    }

    if (!primaryDevice) {
      return res.status(404).json({
        error: isRedisConfigured
          ? 'Primary device not found for this Connection Code. Please verify your connection setup.'
          : 'Primary device session expired in ephemeral mode. Please enable Vercel KV / Upstash Redis, or pair using the QR code directly.',
      });
    }

    // 2. Register Device 2 (Secondary Device)
    const secondaryDevice: DeviceRegistration = {
      deviceId: device.deviceId,
      deviceName: device.deviceName || 'Secondary Device',
      platform: device.platform || 'unknown',
      signingPublicKey: device.signingPublicKey || '',
      exchangePublicKey: device.exchangePublicKey || '',
      lanIp: device.lanIp,
      lanPort: device.lanPort,
      timestamp: Date.now(),
    };
    await registerDeviceInStore(secondaryDevice);

    // 3. Update persistent pairing in store
    const updatedPair: PairedConnection = {
      connectionCode: cleanCode,
      primaryDevice,
      secondaryDevice,
      createdAt: existingPair?.createdAt || Date.now(),
      pairedAt: Date.now(),
    };
    await savePairedConnectionInStore(updatedPair);

    // 4. Send real-time pairing notification event to Device 1 so its SSE stream pops "Hurray!"
    const pairNotificationToDevice1: EncryptedMessagePayload = {
      id: `pair-notify-${Date.now()}`,
      senderDeviceId: secondaryDevice.deviceId,
      recipientDeviceId: primaryDevice.deviceId,
      type: 'device_paired',
      cipherText: Buffer.from(
        JSON.stringify({
          pairedDevice: secondaryDevice,
          message: 'Connection Established! Hurray!',
          timestamp: Date.now(),
        })
      ).toString('base64'),
      nonce: 'system-paired',
      mac: 'system-mac',
      timestamp: Date.now(),
    };
    await enqueueMessageInStore(pairNotificationToDevice1);

    const token = jwt.sign(
      {
        email: user?.email || '',
        deviceId: secondaryDevice.deviceId,
        role: 'MEMBER',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return res.status(200).json({
      success: true,
      token,
      message: 'Hurray! Connection Established!',
      connectionCode: cleanCode,
      user: {
        email: user?.email || '',
        phone: user?.phone || '',
      },
      pairedDevice: primaryDevice,
      peers: [primaryDevice],
    });
  } catch (err: any) {
    console.error('Error in pair-device:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
