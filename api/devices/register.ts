import type { VercelRequest, VercelResponse } from '@vercel/node';
import { registerDeviceInStore, getDeviceFromStore, savePairedConnectionInStore } from '../../lib/redis';
import { DeviceRegistration, PairedConnection } from '../../lib/types';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method === 'GET') {
    const { deviceId } = req.query;
    if (!deviceId || typeof deviceId !== 'string') {
      return res.status(400).json({ error: 'deviceId query param is required' });
    }
    const device = await getDeviceFromStore(deviceId);
    if (!device) {
      return res.status(404).json({ error: 'Device not found or offline' });
    }
    return res.status(200).json({ device });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = req.body as Partial<DeviceRegistration>;

    if (!body.deviceId || !body.signingPublicKey || !body.exchangePublicKey) {
      return res.status(400).json({
        error: 'Missing required fields: deviceId, signingPublicKey, exchangePublicKey',
      });
    }

    const device: DeviceRegistration = {
      deviceId: body.deviceId,
      deviceName: body.deviceName || 'Unknown Device',
      platform: body.platform || 'unknown',
      signingPublicKey: body.signingPublicKey,
      exchangePublicKey: body.exchangePublicKey,
      lanIp: body.lanIp,
      lanPort: body.lanPort,
      timestamp: Date.now(),
    };

    await registerDeviceInStore(device);

    const rawCode = (body as any).connectionCode?.toString();
    if (rawCode) {
      const cleanCode = rawCode.replace(/[^0-9]/g, '').trim();
      if (cleanCode.length === 6) {
        const pair: PairedConnection = {
          connectionCode: cleanCode,
          primaryDevice: device,
          createdAt: Date.now(),
        };
        await savePairedConnectionInStore(pair);
      }
    }

    return res.status(200).json({
      status: 'registered',
      deviceId: device.deviceId,
      ttl: 120,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
