import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isRedisConfigured } from '../lib/redis';

export default function handler(req: VercelRequest, res: VercelResponse) {
  return res.status(200).json({
    name: 'DevSync Serverless Relay Backend',
    version: '1.0.0',
    status: 'online',
    timestamp: Date.now(),
    storage: isRedisConfigured ? 'Upstash Redis (Serverless)' : 'In-Memory (Ephemeral)',
    endpoints: {
      registerDevice: 'POST /api/devices/register',
      lookupDevice: 'GET /api/devices/register?deviceId={id}',
      sendMessage: 'POST /api/messages/send',
      acknowledgeMessage: 'POST /api/messages/ack',
      realtimeEvents: 'GET /api/events?deviceId={id}',
    },
  });
}
