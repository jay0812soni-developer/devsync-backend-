import type { VercelRequest, VercelResponse } from '@vercel/node';
import crypto from 'crypto';

export default function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const turnSecret = process.env.TURN_SECRET || 'devsync-turn-secret-audit-key-2026';
  const expirySeconds = 86400; // 24 hours
  const expiryTimestamp = Math.floor(Date.now() / 1000) + expirySeconds;
  const username = `${expiryTimestamp}:serverless-client`;

  const hmac = crypto.createHmac('sha1', turnSecret);
  hmac.update(username);
  const credential = hmac.digest('base64');

  return res.status(200).json({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      {
        urls: [
          process.env.TURN_URL || 'turn:turn.devsync.network:3478?transport=udp',
          process.env.TURN_TURNS_URL || 'turns:turn.devsync.network:5349?transport=tcp',
        ],
        username,
        credential,
      },
    ],
    ttl: expirySeconds,
  });
}
