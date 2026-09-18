import type { VercelRequest, VercelResponse } from '@vercel/node';
import { enqueueMessageInStore } from '../../lib/redis';
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
    const payload = req.body as Partial<EncryptedMessagePayload>;

    if (
      !payload.id ||
      !payload.senderDeviceId ||
      !payload.recipientDeviceId ||
      !payload.cipherText ||
      !payload.nonce ||
      !payload.mac
    ) {
      return res.status(400).json({
        error: 'Missing required fields: id, senderDeviceId, recipientDeviceId, cipherText, nonce, mac',
      });
    }

    const message: EncryptedMessagePayload = {
      id: payload.id,
      senderDeviceId: payload.senderDeviceId,
      recipientDeviceId: payload.recipientDeviceId,
      type: payload.type || 'text',
      cipherText: payload.cipherText,
      nonce: payload.nonce,
      mac: payload.mac,
      codeLanguage: payload.codeLanguage,
      fileName: payload.fileName,
      fileSize: payload.fileSize,
      sha256: payload.sha256,
      timestamp: payload.timestamp || Date.now(),
    };

    await enqueueMessageInStore(message);

    return res.status(200).json({
      status: 'queued',
      messageId: message.id,
      timestamp: Date.now(),
    });
  } catch (err: any) {
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
