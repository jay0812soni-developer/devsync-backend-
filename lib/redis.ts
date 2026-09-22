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
}

const memoryStorage = new MemoryStorage();

function resolveRedisCredentials(): { url: string; token: string } | null {
  // 1. Check known and prefixed environment variables directly
  const explicitUrl =
    process.env.DEVSYNC_KV_REST_API_URL ||
    process.env.UPSTASH_REDIS_REST_URL ||
    process.env.KV_REST_API_URL ||
    process.env.VERCEL_KV_REST_API_URL ||
    process.env.REDIS_REST_URL ||
    process.env.REDIS_URL;

  const explicitToken =
    process.env.DEVSYNC_KV_REST_API_TOKEN ||
    process.env.UPSTASH_REDIS_REST_TOKEN ||
    process.env.KV_REST_API_TOKEN ||
    process.env.VERCEL_KV_REST_API_TOKEN ||
    process.env.REDIS_REST_TOKEN ||
    process.env.REDIS_TOKEN;

  if (explicitUrl && explicitToken) {
    return { url: explicitUrl, token: explicitToken };
  }

  // 2. Dynamic scan: Find any variable ending with _KV_REST_API_URL or _REST_API_URL
  let candidateUrl: string | undefined;
  let candidateToken: string | undefined;

  for (const [key, val] of Object.entries(process.env)) {
    if (!val) continue;
    if (key.endsWith('_KV_REST_API_URL') || key.endsWith('_REST_API_URL')) {
      candidateUrl = val;
    }
    if (key.endsWith('_KV_REST_API_TOKEN') || key.endsWith('_REST_API_TOKEN')) {
      candidateToken = val;
    }
  }

  if (candidateUrl && candidateToken) {
    return { url: candidateUrl, token: candidateToken };
  }

  return null;
}

function initRedis(): Redis | null {
  // 1. Official Upstash auto-initializer from environment
  try {
    const fromEnv = Redis.fromEnv();
    if (fromEnv) return fromEnv;
  } catch (_) {
    // Fall back to manual/prefixed credential scan
  }

  // 2. Custom scan for DEVSYNC_KV_REST_API_URL or other Vercel prefixed variables
  const creds = resolveRedisCredentials();
  if (creds) {
    try {
      return new Redis({
        url: creds.url,
        token: creds.token,
      });
    } catch (_) {}
  }

  return null;
}

export const redis = initRedis();
export const isRedisConfigured = !!redis;

// Track used OTPs to prevent replay attacks
const usedOtps = new Set<string>();

export async function markOtpUsed(email: string, otp: string): Promise<void> {
  const key = `used_otp:${email.toLowerCase().trim()}:${otp.trim()}`;
  if (redis) {
    await redis.set(key, '1', { ex: 900 }); // 15 min TTL
  } else {
    usedOtps.add(key);
  }
}

export async function isOtpUsed(email: string, otp: string): Promise<boolean> {
  const key = `used_otp:${email.toLowerCase().trim()}:${otp.trim()}`;
  if (redis) {
    const val = await redis.get(key);
    return !!val;
  }
  return usedOtps.has(key);
}

// --- Device Store ---

export async function registerDeviceInStore(device: DeviceRegistration): Promise<void> {
  if (redis) {
    await redis.set(`device:${device.deviceId}`, JSON.stringify(device), { ex: 300 }); // 5 min TTL
  } else {
    await memoryStorage.setDevice(device, 300);
  }
}

export async function getDeviceFromStore(deviceId: string): Promise<DeviceRegistration | null> {
  if (redis) {
    const raw = await redis.get<string>(`device:${deviceId}`);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as DeviceRegistration);
  }
  return memoryStorage.getDevice(deviceId);
}

// --- Message Queue Store ---

export async function enqueueMessageInStore(message: EncryptedMessagePayload): Promise<void> {
  if (redis) {
    await redis.rpush(`queue:${message.recipientDeviceId}`, JSON.stringify(message));
    await redis.expire(`queue:${message.recipientDeviceId}`, 60 * 60 * 24 * 7);
  } else {
    await memoryStorage.enqueueMessage(message);
  }
}

export async function fetchAndClearMessages(recipientDeviceId: string): Promise<EncryptedMessagePayload[]> {
  if (redis) {
    const rawList = await redis.lrange(`queue:${recipientDeviceId}`, 0, -1);
    if (!rawList || rawList.length === 0) return [];
    await redis.del(`queue:${recipientDeviceId}`);
    return rawList.map((item) =>
      typeof item === 'string' ? JSON.parse(item) : (item as EncryptedMessagePayload)
    );
  }
  return memoryStorage.pollMessages(recipientDeviceId);
}

export async function deleteMessageOnAck(recipientDeviceId: string, messageId: string): Promise<void> {
  if (redis) {
    const rawList = await redis.lrange(`queue:${recipientDeviceId}`, 0, -1);
    if (!rawList) return;
    for (const item of rawList) {
      const parsed = typeof item === 'string' ? JSON.parse(item) : item;
      if (parsed.id === messageId) {
        await redis.lrem(`queue:${recipientDeviceId}`, 1, typeof item === 'string' ? item : JSON.stringify(item));
        break;
      }
    }
  } else {
    await memoryStorage.removeMessage(recipientDeviceId, messageId);
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

  if (redis) {
    await redis.set(`otp:${record.email}`, JSON.stringify(record), { ex: ttlSeconds });
  } else {
    await memoryStorage.setOtp(record);
  }
}

export async function fetchOtp(email: string): Promise<OtpRecord | null> {
  if (redis) {
    const raw = await redis.get<string>(`otp:${email.toLowerCase()}`);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as OtpRecord);
  }
  return memoryStorage.getOtp(email);
}

export async function removeOtp(email: string): Promise<void> {
  if (redis) {
    await redis.del(`otp:${email.toLowerCase()}`);
  } else {
    await memoryStorage.deleteOtp(email);
  }
}

// --- User Account Store ---

export async function saveUserInStore(user: UserAccount): Promise<void> {
  if (redis) {
    await redis.set(`user:${user.email.toLowerCase()}`, JSON.stringify(user));
    await redis.set(`code_map:${user.connectionCode}`, user.email.toLowerCase());
  } else {
    await memoryStorage.saveUser(user);
  }
}

export async function getUserByEmailFromStore(email: string): Promise<UserAccount | null> {
  if (redis) {
    const raw = await redis.get<string>(`user:${email.toLowerCase()}`);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as UserAccount);
  }
  return memoryStorage.getUserByEmail(email);
}

export async function getUserByConnectionCodeFromStore(code: string): Promise<UserAccount | null> {
  if (redis) {
    const email = await redis.get<string>(`code_map:${code}`);
    if (!email) return null;
    return getUserByEmailFromStore(email);
  }
  return memoryStorage.getUserByConnectionCode(code);
}

// --- Cross-Device Connection Pairing Store ---

export async function savePairedConnectionInStore(pair: PairedConnection): Promise<void> {
  if (redis) {
    await redis.set(`pairing:${pair.connectionCode}`, JSON.stringify(pair));
  } else {
    await memoryStorage.savePairing(pair);
  }
}

export async function getPairedConnectionFromStore(code: string): Promise<PairedConnection | null> {
  if (redis) {
    const raw = await redis.get<string>(`pairing:${code}`);
    if (!raw) return null;
    return typeof raw === 'string' ? JSON.parse(raw) : (raw as PairedConnection);
  }
  return memoryStorage.getPairing(code);
}
