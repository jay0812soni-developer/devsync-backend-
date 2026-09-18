import type { VercelRequest, VercelResponse } from '@vercel/node';
import { deleteMessageOnAck } from '../../lib/redis';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { messageId, recipientDeviceId } = req.body;

    if (!messageId || !recipientDeviceId) {
      return res.status(400).json({ error: 'messageId and recipientDeviceId are required' });
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
