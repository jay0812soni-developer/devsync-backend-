import crypto from 'crypto';
import { redis } from './redis';

export interface UserRecord {
  id: string;
  email: string;
  phone: string;
  createdAt: number;
  updatedAt: number;
}

export interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  platform: string;
  signingPublicKey: string;
  exchangePublicKey: string;
  lanIp?: string;
  lanPort?: number;
  isOnline: boolean;
  lastSeenAt: number;
  createdAt: number;
}

export interface DeviceGroupRecord {
  id: string;
  ownerUserId: string;
  name: string;
  connectionCode: string;
  connectionCodeExpiresAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface DeviceGroupMemberRecord {
  id: string;
  groupId: string;
  deviceId: string;
  role: 'PRIMARY' | 'MEMBER';
  status: 'ACTIVE' | 'PENDING' | 'REVOKED';
  joinedAt: number;
  approvedByDeviceId?: string;
}

export interface PairingRequestRecord {
  id: string;
  groupId: string;
  code: string;
  initiatorDeviceId: string;
  initiatorDeviceName: string;
  platform: string;
  signingPublicKey: string;
  exchangePublicKey: string;
  lanIp?: string;
  lanPort?: number;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'EXPIRED';
  expiresAt: number;
  createdAt: number;
}

export interface MeshMessageRecord {
  id: string;
  groupId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  type: 'text' | 'code' | 'file_offer' | 'status_update' | 'webrtc_signal' | 'pairing_prompt' | 'pairing_ack';
  cipherText: string;
  nonce: string;
  mac: string;
  codeLanguage?: string;
  fileName?: string;
  fileSize?: number;
  sha256?: string;
  metadata?: Record<string, any>;
  status: 'queued' | 'delivered' | 'read';
  createdAt: number;
  deliveredAt?: number;
}

// In-Memory Mesh Fallback Store
class MeshMemoryStore {
  users = new Map<string, UserRecord>(); // id -> user
  usersByEmail = new Map<string, string>(); // email -> userId
  groups = new Map<string, DeviceGroupRecord>(); // id -> group
  groupByCode = new Map<string, string>(); // code -> groupId
  devices = new Map<string, DeviceRecord>(); // deviceId -> device
  members = new Map<string, DeviceGroupMemberRecord[]>(); // groupId -> members
  pairingRequests = new Map<string, PairingRequestRecord>(); // id -> request
  pairingByCode = new Map<string, string>(); // code -> requestId
  messages = new Map<string, MeshMessageRecord[]>(); // recipientDeviceId -> messages
  failedAttempts = new Map<string, { count: number; resetAt: number }>();
}

const memory = new MeshMemoryStore();

// --- Rate Limiting for Pairing / Auth ---
export async function checkRateLimit(key: string, maxAttempts: number = 5, windowMs: number = 600000): Promise<{ allowed: boolean; remaining: number }> {
  const now = Date.now();
  if (redis) {
    try {
      const redisKey = `ratelimit:${key}`;
      const current = await redis.incr(redisKey);
      if (current === 1) {
        await redis.pexpire(redisKey, windowMs);
      }
      return {
        allowed: current <= maxAttempts,
        remaining: Math.max(0, maxAttempts - current),
      };
    } catch (_) {}
  }

  const existing = memory.failedAttempts.get(key);
  if (!existing || now > existing.resetAt) {
    memory.failedAttempts.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxAttempts - 1 };
  }

  existing.count++;
  return {
    allowed: existing.count <= maxAttempts,
    remaining: Math.max(0, maxAttempts - existing.count),
  };
}

// --- Users & Device Groups ---
export async function getOrCreateUser(email: string, phone: string = ''): Promise<{ user: UserRecord; group: DeviceGroupRecord }> {
  const cleanEmail = email.toLowerCase().trim();
  let user: UserRecord | null = null;
  let group: DeviceGroupRecord | null = null;

  if (redis) {
    try {
      const userId = await redis.get<string>(`user_email:${cleanEmail}`);
      if (userId) {
        const u = await redis.get<string>(`user:${userId}`);
        if (u) user = typeof u === 'string' ? JSON.parse(u) : u;
        const g = await redis.get<string>(`user_group:${userId}`);
        if (g) group = typeof g === 'string' ? JSON.parse(g) : g;
      }
    } catch (e) {
      console.warn('[Mesh] Redis getOrCreateUser error:', e);
    }
  } else {
    const userId = memory.usersByEmail.get(cleanEmail);
    if (userId) {
      user = memory.users.get(userId) || null;
      for (const g of memory.groups.values()) {
        if (g.ownerUserId === userId) {
          group = g;
          break;
        }
      }
    }
  }

  if (!user) {
    const now = Date.now();
    const userId = `usr_${crypto.randomUUID()}`;
    user = {
      id: userId,
      email: cleanEmail,
      phone,
      createdAt: now,
      updatedAt: now,
    };

    // Generate cryptographically secure 6-digit connection code (5-minute TTL)
    const code = crypto.randomInt(100000, 1000000).toString();
    const groupId = `grp_${crypto.randomUUID()}`;
    const codeTtl = 5 * 60 * 1000; // 5 minutes single-use
    group = {
      id: groupId,
      ownerUserId: userId,
      name: `${cleanEmail}'s Personal Network`,
      connectionCode: code,
      connectionCodeExpiresAt: now + codeTtl,
      createdAt: now,
      updatedAt: now,
    };

    // Save in Memory
    memory.users.set(userId, user);
    memory.usersByEmail.set(cleanEmail, userId);
    memory.groups.set(groupId, group);
    memory.groupByCode.set(code, groupId);
    memory.members.set(groupId, []);

    // Save in Redis
    if (redis) {
      try {
        await redis.set(`user:${userId}`, JSON.stringify(user));
        await redis.set(`user_email:${cleanEmail}`, userId);
        await redis.set(`group:${groupId}`, JSON.stringify(group));
        await redis.set(`group_code:${code}`, groupId, { ex: 300 });
        await redis.set(`user_group:${userId}`, JSON.stringify(group));
      } catch (e) {
        console.warn('[Mesh] Redis save user error:', e);
      }
    }
  }

  return { user, group: group! };
}

/**
 * Atomically claims and consumes a single-use pairing code.
 * If the code is valid and unexpired, it is immediately deleted from both Redis
 * and memory so that no other concurrent or subsequent request can claim it.
 */
export async function claimPairingCode(code: string): Promise<DeviceGroupRecord | null> {
  const cleanCode = code.trim();
  let groupId: string | null = null;

  // 1. Atomic Redis claim (using Lua script for true atomicity under race conditions)
  if (redis) {
    try {
      const luaScript = `
        local gid = redis.call('GET', KEYS[1])
        if gid then
          redis.call('DEL', KEYS[1])
          return gid
        else
          return nil
        end
      `;
      const res = await (redis as any).eval(luaScript, 1, `group_code:${cleanCode}`);
      if (res && typeof res === 'string') {
        groupId = res;
      }
    } catch (_) {
      try {
        const val = await redis.get<string>(`group_code:${cleanCode}`);
        if (val) {
          await redis.del(`group_code:${cleanCode}`);
          groupId = val;
        }
      } catch (_) {}
    }
  }

  // 2. Atomic In-Memory claim (synchronous atomic check and delete)
  if (!groupId) {
    groupId = memory.groupByCode.get(cleanCode) || null;
    if (groupId) {
      memory.groupByCode.delete(cleanCode);
    }
  } else {
    // If Redis claimed it, also clean local in-memory cache
    memory.groupByCode.delete(cleanCode);
  }

  if (!groupId) {
    return null; // Code already claimed, expired, or non-existent
  }

  // 3. Retrieve group and verify expiration
  let group: DeviceGroupRecord | null = null;
  if (redis) {
    try {
      const raw = await redis.get<string>(`group:${groupId}`);
      if (raw) group = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {}
  }
  if (!group) {
    group = memory.groups.get(groupId) || null;
  }

  if (!group) return null;

  // Check TTL
  if (group.connectionCodeExpiresAt && Date.now() > group.connectionCodeExpiresAt) {
    return null; // Expired
  }

  // Clear connection code from group record so it cannot be read back
  group.connectionCode = '';
  if (redis) {
    try {
      await redis.set(`group:${group.id}`, JSON.stringify(group));
    } catch (_) {}
  }
  memory.groups.set(group.id, group);

  return group;
}

/**
 * Generates a fresh, cryptographically random, short-lived (5 min), single-use pairing code for a group.
 */
export async function generatePairingCodeForGroup(
  groupId: string,
  ttlSeconds: number = 300
): Promise<{ code: string; expiresAt: number }> {
  const code = crypto.randomInt(100000, 1000000).toString();
  const expiresAt = Date.now() + ttlSeconds * 1000;

  let group: DeviceGroupRecord | null = null;
  if (redis) {
    try {
      const raw = await redis.get<string>(`group:${groupId}`);
      if (raw) group = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {}
  }
  if (!group) {
    group = memory.groups.get(groupId) || null;
  }

  if (!group) {
    throw new Error('Group not found');
  }

  // Clean old code if any
  if (group.connectionCode) {
    memory.groupByCode.delete(group.connectionCode);
    if (redis) {
      try {
        await redis.del(`group_code:${group.connectionCode}`);
      } catch (_) {}
    }
  }

  // Set new code
  group.connectionCode = code;
  group.connectionCodeExpiresAt = expiresAt;

  memory.groups.set(groupId, group);
  memory.groupByCode.set(code, groupId);

  if (redis) {
    try {
      await redis.set(`group:${groupId}`, JSON.stringify(group));
      await redis.set(`group_code:${code}`, groupId, { ex: ttlSeconds });
    } catch (e) {
      console.warn('[Mesh] Redis save pairing code error:', e);
    }
  }

  return { code, expiresAt };
}

export async function getGroupByCode(code: string): Promise<DeviceGroupRecord | null> {
  const cleanCode = code.trim();
  let groupId: string | null = null;
  if (redis) {
    try {
      groupId = await redis.get<string>(`group_code:${cleanCode}`);
    } catch (_) {}
  }
  if (!groupId) {
    groupId = memory.groupByCode.get(cleanCode) || null;
  }
  if (!groupId) return null;

  let group: DeviceGroupRecord | null = null;
  if (redis) {
    try {
      const raw = await redis.get<string>(`group:${groupId}`);
      if (raw) group = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {}
  }
  if (!group) {
    group = memory.groups.get(groupId) || null;
  }

  if (group && group.connectionCodeExpiresAt && Date.now() > group.connectionCodeExpiresAt) {
    return null; // Expired
  }

  return group;
}

// --- Devices & Mesh Membership ---
export async function registerDeviceInMesh(
  device: Omit<DeviceRecord, 'createdAt' | 'lastSeenAt' | 'isOnline'>,
  groupId: string,
  isPrimary: boolean = false
): Promise<{ device: DeviceRecord; member: DeviceGroupMemberRecord }> {
  const now = Date.now();
  const fullDevice: DeviceRecord = {
    ...device,
    isOnline: true,
    lastSeenAt: now,
    createdAt: now,
  };

  // Upsert Device
  memory.devices.set(device.deviceId, fullDevice);
  if (redis) {
    try {
      await redis.set(`device:${device.deviceId}`, JSON.stringify(fullDevice), { ex: 3600 * 24 * 30 });
    } catch (_) {}
  }

  // Upsert Group Membership
  const currentMembers = memory.members.get(groupId) || [];
  let existingMember = currentMembers.find((m) => m.deviceId === device.deviceId);

  if (!existingMember) {
    existingMember = {
      id: `mem_${crypto.randomUUID()}`,
      groupId,
      deviceId: device.deviceId,
      role: isPrimary ? 'PRIMARY' : 'MEMBER',
      status: 'ACTIVE',
      joinedAt: now,
    };
    currentMembers.push(existingMember);
    memory.members.set(groupId, currentMembers);
  } else {
    existingMember.status = 'ACTIVE';
    if (isPrimary) existingMember.role = 'PRIMARY';
  }

  if (redis) {
    try {
      await redis.set(`group_members:${groupId}`, JSON.stringify(currentMembers));
      await redis.set(`device_group:${device.deviceId}`, groupId);
    } catch (_) {}
  }

  return { device: fullDevice, member: existingMember };
}

export async function getGroupMembers(groupId: string): Promise<Array<DeviceRecord & { role: 'PRIMARY' | 'MEMBER'; status: string }>> {
  let memberRecords: DeviceGroupMemberRecord[] = [];
  if (redis) {
    try {
      const raw = await redis.get<string>(`group_members:${groupId}`);
      if (raw) {
        memberRecords = typeof raw === 'string' ? JSON.parse(raw) : raw;
      }
    } catch (_) {}
  }

  if (memberRecords.length === 0) {
    memberRecords = memory.members.get(groupId) || [];
  }

  const results: Array<DeviceRecord & { role: 'PRIMARY' | 'MEMBER'; status: string }> = [];

  for (const m of memberRecords) {
    if (m.status === 'REVOKED') continue;
    let dev: DeviceRecord | null = null;
    if (redis) {
      try {
        const rawDev = await redis.get<string>(`device:${m.deviceId}`);
        if (rawDev) dev = typeof rawDev === 'string' ? JSON.parse(rawDev) : rawDev;
      } catch (_) {}
    }
    if (!dev) {
      dev = memory.devices.get(m.deviceId) || null;
    }

    if (dev) {
      results.push({
        ...dev,
        role: m.role,
        status: m.status,
      });
    }
  }

  return results;
}

export async function revokeDeviceFromMesh(groupId: string, deviceId: string): Promise<boolean> {
  let members = memory.members.get(groupId) || [];
  if (redis) {
    try {
      const raw = await redis.get<string>(`group_members:${groupId}`);
      if (raw) members = typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (_) {}
  }

  const target = members.find((m) => m.deviceId === deviceId);
  if (!target) return false;

  target.status = 'REVOKED';
  memory.members.set(groupId, members);

  if (redis) {
    try {
      await redis.set(`group_members:${groupId}`, JSON.stringify(members));
      await redis.del(`device_group:${deviceId}`);
    } catch (_) {}
  }

  return true;
}

export async function updateDeviceHeartbeat(deviceId: string, isOnline: boolean = true): Promise<void> {
  const now = Date.now();
  let dev = memory.devices.get(deviceId);
  if (dev) {
    dev.isOnline = isOnline;
    dev.lastSeenAt = now;
  }
  if (redis) {
    try {
      const raw = await redis.get<string>(`device:${deviceId}`);
      if (raw) {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        parsed.isOnline = isOnline;
        parsed.lastSeenAt = now;
        await redis.set(`device:${deviceId}`, JSON.stringify(parsed), { ex: 3600 * 24 * 30 });
      }
    } catch (_) {}
  }
}

// --- Non-Destructive Offline Message Queue ---
export async function enqueueMeshMessage(message: Omit<MeshMessageRecord, 'status' | 'createdAt'>): Promise<MeshMessageRecord> {
  const record: MeshMessageRecord = {
    ...message,
    status: 'queued',
    createdAt: Date.now(),
  };

  const list = memory.messages.get(message.recipientDeviceId) || [];
  list.push(record);
  memory.messages.set(message.recipientDeviceId, list);

  if (redis) {
    try {
      await redis.rpush(`mesh_queue:${message.recipientDeviceId}`, JSON.stringify(record));
      await redis.expire(`mesh_queue:${message.recipientDeviceId}`, 60 * 60 * 24 * 7); // 7-day retention
    } catch (e) {
      console.warn('[Mesh] Redis enqueue message error:', e);
    }
  }

  return record;
}

export async function peekMeshMessages(recipientDeviceId: string): Promise<MeshMessageRecord[]> {
  if (redis) {
    try {
      const rawList = await redis.lrange(`mesh_queue:${recipientDeviceId}`, 0, -1);
      if (rawList && rawList.length > 0) {
        return rawList.map((item) => (typeof item === 'string' ? JSON.parse(item) : item));
      }
    } catch (e) {
      console.warn('[Mesh] Redis peek messages error:', e);
    }
  }

  return memory.messages.get(recipientDeviceId) || [];
}

export async function ackMeshMessage(recipientDeviceId: string, messageId: string): Promise<boolean> {
  // Explicit client delivery confirmation removes from queue
  const list = memory.messages.get(recipientDeviceId) || [];
  const initialLen = list.length;
  const filtered = list.filter((m) => m.id !== messageId);
  memory.messages.set(recipientDeviceId, filtered);

  let removed = filtered.length < initialLen;

  if (redis) {
    try {
      const rawList = await redis.lrange(`mesh_queue:${recipientDeviceId}`, 0, -1);
      if (rawList) {
        for (const item of rawList) {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          if (parsed.id === messageId) {
            await redis.lrem(`mesh_queue:${recipientDeviceId}`, 1, typeof item === 'string' ? item : JSON.stringify(item));
            removed = true;
            break;
          }
        }
      }
    } catch (e) {
      console.warn('[Mesh] Redis ack message error:', e);
    }
  }

  return removed;
}
