import { Redis } from '@upstash/redis';
import { DeviceRegistration, EncryptedMessagePayload, UserAccount, OtpRecord, PairedConnection } from './types';

// In-memory fallback for local development or testing without Redis credentials
class MemoryStorage {
  private devices = new Map<string, { data: DeviceRegistration; expires: number }>();
  private queues = new Map<string, EncryptedMessagePayload[]>();
  private otps = new Map<string, OtpRecord>();
  private usersByEmail = new Map<string, UserAccount>();
  private usersByCode = new Map<string, UserAccount>();
  private pairings = new Map<string, PairedConnection>(); // Key: connectionCode

  // Devices
  async setDevice(device: DeviceRegistration, ttlSeconds: number = 120): Promise<void> {
    this.devices.set(device.deviceId, {
      data: device,
      expires: Date.now() + ttlSeconds * 1000,
    });
  }

  async getDevice(deviceId: string): Promise<DeviceRegistration | null> {
    const item = this.devices.get(deviceId);
    if (!item) return null;
    if (Date.now() > item.expires) {
      this.devices.delete(deviceId);
      return null;
    }
    return item.data;
  }

  // Messages
  async enqueueMessage(message: EncryptedMessagePayload): Promise<void> {
    const list = this.queues.get(message.recipientDeviceId) || [];
    list.push(message);
    this.queues.set(message.recipientDeviceId, list);
  }

  async pollMessages(recipientDeviceId: string): Promise<EncryptedMessagePayload[]> {
    const list = this.queues.get(recipientDeviceId) || [];
    this.queues.set(recipientDeviceId, []);
    return list;
  }

  async removeMessage(recipientDeviceId: string, messageId: string): Promise<boolean> {
    const list = this.queues.get(recipientDeviceId);
    if (!list) return false;
    const initialLen = list.length;
    const filtered = list.filter((m) => m.id !== messageId);
    this.queues.set(recipientDeviceId, filtered);
    return filtered.length < initialLen;
  }

  // OTPs
  async setOtp(record: OtpRecord): Promise<void> {
    this.otps.set(record.email.toLowerCase(), record);
  }

  async getOtp(email: string): Promise<OtpRecord | null> {
    const item = this.otps.get(email.toLowerCase());
    if (!item) return null;
    if (Date.now() > item.expiresAt) {
      this.otps.delete(email.toLowerCase());
      return null;
    }
    return item;
  }

  async deleteOtp(email: string): Promise<void> {
    this.otps.delete(email.toLowerCase());
  }

  // Users
  async saveUser(user: UserAccount): Promise<void> {
    this.usersByEmail.set(user.email.toLowerCase(), user);
    this.usersByCode.set(user.connectionCode, user);
  }

  async getUserByEmail(email: string): Promise<UserAccount | null> {
    return this.usersByEmail.get(email.toLowerCase()) || null;
  }

  async getUserByConnectionCode(code: string): Promise<UserAccount | null> {
    return this.usersByCode.get(code) || null;
  }

  // Pairings
  async savePairing(pair: PairedConnection): Promise<void> {
    this.pairings.set(pair.connectionCode, pair);
  }

  async getPairing(code: string): Promise<PairedConnection | null> {
    return this.pairings.get(code) || null;
  }

  // Multi-Device Groups
  private groupDevices = new Map<string, DeviceRegistration[]>(); // Key: connectionCode
  private deviceCodes = new Map<string, string>(); // Key: deviceId -> connectionCode

  async addGroupDevice(connectionCode: string, device: DeviceRegistration, isPrimary: boolean = false): Promise<DeviceRegistration[]> {
    const list = this.groupDevices.get(connectionCode) || [];
    const idx = list.findIndex((d) => d.deviceId === device.deviceId);
    if (idx >= 0) {
      list[idx] = device;
    } else {
      if (isPrimary) {
        list.unshift(device);
      } else {
        list.push(device);
      }
    }
    this.groupDevices.set(connectionCode, list);
    this.deviceCodes.set(device.deviceId, connectionCode);
    return list;
  }

  async getGroupDevices(connectionCode: string): Promise<DeviceRegistration[]> {
    return this.groupDevices.get(connectionCode) || [];
  }

  async getCodeForDevice(deviceId: string): Promise<string | null> {
    return this.deviceCodes.get(deviceId) || null;
  }
}

const memoryStorage = new MemoryStorage();

function resolveRedisCredentials(): { url: string; token: string } | null {
  // 1. Check known and prefixed environment variables directly
  const explicitUrl =
    process.env.DEVSYNC_KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    process.env.VERCEL_KV_REST_API_URL;

  const explicitToken =
    process.env.DEVSYNC_KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.VERCEL_KV_REST_API_TOKEN;

  if (explicitUrl && explicitToken) {
    return { url: explicitUrl, token: explicitToken };
  }

  // 2. Dynamic scan: Find any variable ending with _KV_REST_API_URL or _REST_API_URL
  let candidateUrl: string | undefined;
  let candidateToken: string | undefined;

  for (const [key, val] of Object.entries(process.env)) {
    if (!val || typeof val !== 'string') continue;
    if (key.includes('READ_ONLY')) continue;

    if (
      key.endsWith('_KV_REST_API_URL') ||
      key.endsWith('_REST_API_URL') ||
      key.endsWith('_REDIS_REST_URL') ||
      key === 'KV_REST_API_URL' ||
      key === 'UPSTASH_REDIS_REST_URL'
    ) {
      candidateUrl = val;
    }

    if (
      key.endsWith('_KV_REST_API_TOKEN') ||
      key.endsWith('_REST_API_TOKEN') ||
      key.endsWith('_REDIS_REST_TOKEN') ||
      key === 'KV_REST_API_TOKEN' ||
      key === 'UPSTASH_REDIS_REST_TOKEN'
    ) {
      candidateToken = val;
    }
  }

  if (candidateUrl && candidateToken) {
    return { url: candidateUrl, token: candidateToken };
  }

  return null;
}

function initRedis(): Redis | null {
  // 1. Resolve explicit/prefixed credentials FIRST
  const creds = resolveRedisCredentials();
  if (creds && creds.url && creds.token) {
    let cleanUrl = creds.url.trim();
    if (!cleanUrl.startsWith('http://') && !cleanUrl.startsWith('https://')) {
      cleanUrl = `https://${cleanUrl}`;
    }
    try {
      console.log(`[DevSync Redis] Connected to Upstash Redis at ${cleanUrl}`);
      return new Redis({
        url: cleanUrl,
        token: creds.token.trim(),
      });
    } catch (err) {
      console.error('[DevSync Redis] Failed to initialize from credentials:', err);
    }
  }

  // 2. ONLY attempt Redis.fromEnv() if standard env vars are explicitly non-empty strings
  const standardUrl = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const standardToken = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (standardUrl && standardToken) {
    try {
      return Redis.fromEnv();
    } catch (_) {}
  }

  console.warn('[DevSync Redis] No Redis credentials found. Falling back to MemoryStorage.');
  return null;
}

export const redis = initRedis();
export const isRedisConfigured = !!redis;

// Track used OTPs to prevent replay attacks
const usedOtps = new Set<string>();

export async function markOtpUsed(email: string, otp: string): Promise<void> {
  const key = `used_otp:${email.toLowerCase().trim()}:${otp.trim()}`;
  usedOtps.add(key);
  if (redis) {
    try {
      await redis.set(key, '1', { ex: 900 });
    } catch (e) {
      console.warn('Redis markOtpUsed error:', e);
    }
  }
}

export async function isOtpUsed(email: string, otp: string): Promise<boolean> {
  const key = `used_otp:${email.toLowerCase().trim()}:${otp.trim()}`;
  if (redis) {
    try {
      const val = await redis.get(key);
      if (val) return true;
    } catch (e) {
      console.warn('Redis isOtpUsed error:', e);
    }
  }
  return usedOtps.has(key);
}

// --- Device Store ---

export async function registerDeviceInStore(device: DeviceRegistration): Promise<void> {
  await memoryStorage.setDevice(device, 300);
  if (redis) {
    try {
      await redis.set(`device:${device.deviceId}`, JSON.stringify(device), { ex: 300 });
    } catch (e) {
      console.warn('Redis registerDeviceInStore error:', e);
    }
  }
}

export async function getDeviceFromStore(deviceId: string): Promise<DeviceRegistration | null> {
  if (redis) {
    try {
      const raw = await redis.get<string>(`device:${deviceId}`);
      if (raw) {
        return typeof raw === 'string' ? JSON.parse(raw) : (raw as DeviceRegistration);
      }
    } catch (e) {
      console.warn('Redis getDeviceFromStore error:', e);
    }
  }
  return memoryStorage.getDevice(deviceId);
}

// --- Message Queue Store ---

export async function enqueueMessageInStore(message: EncryptedMessagePayload): Promise<void> {
  await memoryStorage.enqueueMessage(message);
  if (redis) {
    try {
      await redis.rpush(`queue:${message.recipientDeviceId}`, JSON.stringify(message));
      await redis.expire(`queue:${message.recipientDeviceId}`, 60 * 60 * 24 * 7);
    } catch (e) {
      console.warn('Redis enqueueMessageInStore error:', e);
    }
  }
}

export async function fetchAndClearMessages(recipientDeviceId: string): Promise<EncryptedMessagePayload[]> {
  if (redis) {
    try {
      const rawList = await redis.lrange(`queue:${recipientDeviceId}`, 0, -1);
      if (rawList && rawList.length > 0) {
        await redis.del(`queue:${recipientDeviceId}`);
        return rawList.map((item) =>
          typeof item === 'string' ? JSON.parse(item) : (item as EncryptedMessagePayload)
        );
      }
    } catch (e) {
      console.warn('Redis fetchAndClearMessages error:', e);
    }
  }
  return memoryStorage.pollMessages(recipientDeviceId);
}

export async function deleteMessageOnAck(recipientDeviceId: string, messageId: string): Promise<void> {
  await memoryStorage.removeMessage(recipientDeviceId, messageId);
  if (redis) {
    try {
      const rawList = await redis.lrange(`queue:${recipientDeviceId}`, 0, -1);
      if (rawList) {
        for (const item of rawList) {
          const parsed = typeof item === 'string' ? JSON.parse(item) : item;
          if (parsed.id === messageId) {
            await redis.lrem(`queue:${recipientDeviceId}`, 1, typeof item === 'string' ? item : JSON.stringify(item));
            break;
          }
        }
      }
    } catch (e) {
      console.warn('Redis deleteMessageOnAck error:', e);
    }
  }
}

// --- OTP Management Store ---

export async function storeOtp(email: string, phone: string, otp: string, ttlSeconds: number = 600): Promise<void> {
  const record: OtpRecord = {
    email: email.toLowerCase(),
    phone,
    otp,
    expiresAt: Date.now() + ttlSeconds * 1000,
    attempts: 0,
  };
  await memoryStorage.setOtp(record);
  if (redis) {
    try {
      await redis.set(`otp:${record.email}`, JSON.stringify(record), { ex: ttlSeconds });
    } catch (e) {
      console.warn('Redis storeOtp error:', e);
    }
  }
}

export async function fetchOtp(email: string): Promise<OtpRecord | null> {
  if (redis) {
    try {
      const raw = await redis.get<string>(`otp:${email.toLowerCase()}`);
      if (raw) {
        return typeof raw === 'string' ? JSON.parse(raw) : (raw as OtpRecord);
      }
    } catch (e) {
      console.warn('Redis fetchOtp error:', e);
    }
  }
  return memoryStorage.getOtp(email);
}

export async function removeOtp(email: string): Promise<void> {
  await memoryStorage.deleteOtp(email);
  if (redis) {
    try {
      await redis.del(`otp:${email.toLowerCase()}`);
    } catch (e) {
      console.warn('Redis removeOtp error:', e);
    }
  }
}

// --- User Account Store ---

export async function saveUserInStore(user: UserAccount): Promise<void> {
  await memoryStorage.saveUser(user);
  if (redis) {
    try {
      await redis.set(`user:${user.email.toLowerCase()}`, JSON.stringify(user));
      await redis.set(`code_map:${user.connectionCode}`, user.email.toLowerCase());
    } catch (e) {
      console.warn('Redis saveUserInStore error:', e);
    }
  }
}

export async function getUserByEmailFromStore(email: string): Promise<UserAccount | null> {
  if (redis) {
    try {
      const raw = await redis.get<string>(`user:${email.toLowerCase()}`);
      if (raw) {
        return typeof raw === 'string' ? JSON.parse(raw) : (raw as UserAccount);
      }
    } catch (e) {
      console.warn('Redis getUserByEmailFromStore error:', e);
    }
  }
  return memoryStorage.getUserByEmail(email);
}

export async function getUserByConnectionCodeFromStore(code: string): Promise<UserAccount | null> {
  if (redis) {
    try {
      const email = await redis.get<string>(`code_map:${code}`);
      if (email) {
        return getUserByEmailFromStore(email);
      }
    } catch (e) {
      console.warn('Redis getUserByConnectionCodeFromStore error:', e);
    }
  }
  return memoryStorage.getUserByConnectionCode(code);
}

// --- Cross-Device Connection Pairing Store ---

export async function savePairedConnectionInStore(pair: PairedConnection): Promise<void> {
  await memoryStorage.savePairing(pair);
  if (redis) {
    try {
      await redis.set(`pairing:${pair.connectionCode}`, JSON.stringify(pair));
    } catch (e) {
      console.warn('Redis savePairedConnectionInStore error:', e);
    }
  }
}

export async function getPairedConnectionFromStore(code: string): Promise<PairedConnection | null> {
  if (redis) {
    try {
      const raw = await redis.get<string>(`pairing:${code}`);
      if (raw) {
        return typeof raw === 'string' ? JSON.parse(raw) : (raw as PairedConnection);
      }
    } catch (e) {
      console.warn('Redis getPairedConnectionFromStore error:', e);
    }
  }
  return memoryStorage.getPairing(code);
}

// --- Multi-Device Personal Mesh Group Store ---

export async function addDeviceToGroup(
  connectionCode: string,
  device: DeviceRegistration,
  isPrimary: boolean = false
): Promise<DeviceRegistration[]> {
  await memoryStorage.addGroupDevice(connectionCode, device, isPrimary);
  if (redis) {
    try {
      // 1. Map deviceId -> connectionCode for reverse lookup
      await redis.set(`device_code:${device.deviceId}`, connectionCode);

      // 2. Fetch current group list from Redis
      const raw = await redis.get<string>(`group_devices:${connectionCode}`);
      let list: DeviceRegistration[] = [];
      if (raw) {
        list = typeof raw === 'string' ? JSON.parse(raw) : raw;
      }
      const idx = list.findIndex((d) => d.deviceId === device.deviceId);
      if (idx >= 0) {
        list[idx] = device;
      } else {
        if (isPrimary) {
          list.unshift(device);
        } else {
          list.push(device);
        }
      }
      await redis.set(`group_devices:${connectionCode}`, JSON.stringify(list));
      return list;
    } catch (e) {
      console.warn('Redis addDeviceToGroup error:', e);
    }
  }
  return memoryStorage.getGroupDevices(connectionCode);
}

export async function getGroupDevices(connectionCode: string): Promise<DeviceRegistration[]> {
  if (redis) {
    try {
      const raw = await redis.get<string>(`group_devices:${connectionCode}`);
      if (raw) {
        return typeof raw === 'string' ? JSON.parse(raw) : (raw as DeviceRegistration[]);
      }
    } catch (e) {
      console.warn('Redis getGroupDevices error:', e);
    }
  }
  return memoryStorage.getGroupDevices(connectionCode);
}

export async function getGroupCodeForDevice(deviceId: string): Promise<string | null> {
  if (redis) {
    try {
      const code = await redis.get<string>(`device_code:${deviceId}`);
      if (code) return typeof code === 'string' ? code : JSON.stringify(code);
    } catch (e) {
      console.warn('Redis getGroupCodeForDevice error:', e);
    }
  }
  return memoryStorage.getCodeForDevice(deviceId);
}

