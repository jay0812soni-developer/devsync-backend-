import type { VercelRequest, VercelResponse } from '@vercel/node';
import { fetchAndClearMessages } from '../lib/redis';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const { deviceId } = req.query;
  if (!deviceId || typeof deviceId !== 'string') {
    return res.status(400).json({ error: 'deviceId query parameter is required' });
  }

  const isSse = req.headers.accept?.includes('text/event-stream');

  if (isSse) {
    // Set SSE Headers
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Send initial connected heartbeat
    res.write(`event: connected\ndata: ${JSON.stringify({ deviceId, timestamp: Date.now() })}\n\n`);

    // Fetch waiting messages immediately
    const initialMessages = await fetchAndClearMessages(deviceId);
    for (const msg of initialMessages) {
      res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
    }

    // Keep stream alive with periodic pings until function execution timeout
    const interval = setInterval(async () => {
      try {
        const waiting = await fetchAndClearMessages(deviceId);
        for (const msg of waiting) {
          res.write(`event: message\ndata: ${JSON.stringify(msg)}\n\n`);
        }
        res.write(`event: ping\ndata: ${JSON.stringify({ t: Date.now() })}\n\n`);
      } catch (_) {
        clearInterval(interval);
      }
    }, 3000);

    req.on('close', () => {
      clearInterval(interval);
      res.end();
    });

    return;
  }

  // Standard JSON polling fallback
  try {
    const messages = await fetchAndClearMessages(deviceId);
    return res.status(200).json({
      deviceId,
      count: messages.length,
      messages,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
