import type { VercelRequest, VercelResponse } from '@vercel/node';
import jwt from 'jsonwebtoken';
import {
  getGroupDevices,
  getGroupCodeForDevice,
  getUserByEmailFromStore,
  getUserByConnectionCodeFromStore,
  getPairedConnectionFromStore,
} from '../../../lib/redis';

const JWT_SECRET = process.env.JWT_SECRET || 'devsync-mesh-jwt-secret-audit-key-2026';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept, X-Requested-With');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    let connectionCode: string | null = null;

    // 1. Try resolving connection code from Bearer JWT token
    const authHeader = req.headers.authorization;
    if (authHeader && authHeader.startsWith('Bearer ')) {
      const rawToken = authHeader.substring(7).trim();
      try {
        const decoded = jwt.verify(rawToken, JWT_SECRET) as any;
        if (decoded.connectionCode && typeof decoded.connectionCode === 'string') {
          connectionCode = decoded.connectionCode.trim();
        } else if (decoded.deviceId) {
          connectionCode = await getGroupCodeForDevice(decoded.deviceId);
        } else if (decoded.email) {
          const user = await getUserByEmailFromStore(decoded.email);
          connectionCode = user?.connectionCode || null;
        }
      } catch (_) {
        // Token invalid or expired; continue to query fallback
      }
    }

    // 2. Try resolving connection code from query parameter ?code=...
    if (!connectionCode && req.query.code) {
      const candidate = req.query.code.toString().replace(/[^0-9]/g, '').trim();
      if (candidate.length === 6) {
        connectionCode = candidate;
      }
    }

    // 3. Try resolving connection code from query parameter ?deviceId=...
    if (!connectionCode && req.query.deviceId) {
      const devId = req.query.deviceId.toString().trim();
      connectionCode = await getGroupCodeForDevice(devId);
    }

    if (!connectionCode) {
      return res.status(401).json({
        error: 'Valid authorization token, connection code (?code=), or registered deviceId (?deviceId=) required',
      });
    }

    // 4. Fetch all active devices in the group
    let members = await getGroupDevices(connectionCode);

    // Fallback: If group_devices is empty (e.g. legacy pairing), reconstruct from pairedConnection
    if (members.length === 0) {
      const legacyPair = await getPairedConnectionFromStore(connectionCode);
      if (legacyPair) {
        if (legacyPair.primaryDevice) members.push(legacyPair.primaryDevice);
        if (legacyPair.secondaryDevice) members.push(legacyPair.secondaryDevice);
      }
    }

    return res.status(200).json({
      success: true,
      connectionCode,
      members,
    });
  } catch (err: any) {
    console.error('Error fetching group members:', err);
    return res.status(500).json({ error: err.message || 'Internal server error' });
  }
}
