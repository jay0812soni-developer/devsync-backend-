import type { VercelRequest, VercelResponse } from '@vercel/node';
import {
  getGroupDevices,
  getGroupCodeForDevice,
  removeDeviceFromGroup,
  deleteGroupConnection,
  enqueueMessageInStore,
} from '../../lib/redis';
import { verifyBearerToken } from '../../lib/jwt';
import { EncryptedMessagePayload } from '../../lib/types';

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
    const claims = verifyBearerToken(req.headers.authorization);

    const deviceId = rawBody.deviceId || claims?.deviceId;
    let connectionCode = rawBody.connectionCode || claims?.connectionCode;
    const isPrimary = rawBody.isPrimary === true || claims?.role === 'PRIMARY';

    if (!deviceId) {
      return res.status(400).json({ error: 'deviceId is required to log out' });
    }

    if (!connectionCode) {
      connectionCode = await getGroupCodeForDevice(deviceId);
    }

    if (!connectionCode) {
      return res.status(200).json({
        success: true,
        message: 'Device session cleared (no active group connection)',
      });
    }

    const cleanCode = connectionCode.toString().replace(/[^0-9]/g, '').trim();
    const members = await getGroupDevices(cleanCode);

    if (isPrimary) {
      // Primary / Source device logged out -> Cascade logout to ALL other devices
      const otherDevices = members.filter((d) => d.deviceId !== deviceId);

      for (const peer of otherDevices) {
        const logoutNotification: EncryptedMessagePayload = {
          id: `logout-term-${Date.now()}-${peer.deviceId}`,
          senderDeviceId: deviceId,
          recipientDeviceId: peer.deviceId,
          type: 'session_terminated',
          cipherText: Buffer.from(
            JSON.stringify({
              action: 'session_terminated',
              reason: 'Primary device logged out. Personal mesh network closed.',
              timestamp: Date.now(),
            })
          ).toString('base64'),
          nonce: 'sys-logout',
          mac: 'sys-logout',
          timestamp: Date.now(),
        };
        await enqueueMessageInStore(logoutNotification);
      }

      // Purge entire group connection and paired connection from Redis
      await deleteGroupConnection(cleanCode);

      return res.status(200).json({
        success: true,
        cascaded: true,
        message: 'Primary device logged out. Group mesh session terminated for all devices.',
      });
    } else {
      // Secondary device logged out -> Detach this device from group only
      await removeDeviceFromGroup(cleanCode, deviceId);

      const remainingPeers = members.filter((d) => d.deviceId !== deviceId);
      for (const peer of remainingPeers) {
        const leaveNotification: EncryptedMessagePayload = {
          id: `device-left-${Date.now()}-${peer.deviceId}`,
          senderDeviceId: deviceId,
          recipientDeviceId: peer.deviceId,
          type: 'device_left',
          cipherText: Buffer.from(
            JSON.stringify({
              deviceId,
              timestamp: Date.now(),
            })
          ).toString('base64'),
          nonce: 'sys-leave',
          mac: 'sys-leave',
          timestamp: Date.now(),
        };
        await enqueueMessageInStore(leaveNotification);
      }

      return res.status(200).json({
        success: true,
        cascaded: false,
        message: 'Device successfully disconnected from personal mesh.',
      });
    }
  } catch (err: any) {
    console.error('Error in logout handler:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
