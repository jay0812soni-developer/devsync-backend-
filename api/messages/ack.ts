import type { VercelRequest, VercelResponse } from '@vercel/node';
import { deleteMessageOnAck } from '../../lib/redis';
import { verifyBearerToken, unauthorized } from '../../lib/jwt';

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

  // Authenticate caller
  const claims = verifyBearerToken(req.headers.authorization);
  if (!claims) {
    return unauthorized(res, 'Valid Bearer token required to acknowledge messages');
  }

  try {
    const { messageId, recipientDeviceId } = req.body;

    if (!messageId || !recipientDeviceId) {
      return res.status(400).json({ error: 'messageId and recipientDeviceId are required' });
    }

    // Ack spoofing prevention: only the recipient device may acknowledge its own queue
    if (claims.deviceId && recipientDeviceId !== claims.deviceId) {
      return res.status(403).json({
        error: 'Forbidden: recipientDeviceId does not match authenticated device',
      });
    }

    // Immediately purge delivered message from queue
    await deleteMessageOnAck(recipientDeviceId, messageId);

    return res.status(200).json({
      status: 'acknowledged',
      messageId,
      purged: true,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
