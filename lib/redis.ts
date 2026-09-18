import { Redis } from '@upstash/redis';
import { DeviceRegistration, EncryptedMessagePayload } from './types';

// In-memory fallback for local development or testing without Redis credentials
class MemoryStorage {
  private devices = new Map<string, { data: DeviceRegistration; expires: number }>();
  private queues = new Map<string, EncryptedMessagePayload[]>();

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
}

const memoryStorage = new MemoryStorage();

export const isRedisConfigured = !!(
  process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN
);

export const redis = isRedisConfigured
  ? new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL!,
      token: process.env.UPSTASH_REDIS_REST_TOKEN!,
    })
  : null;

export async function registerDeviceInStore(device: DeviceRegistration): Promise<void> {
  if (redis) {
    // Save device info with 2 minute TTL
    await redis.set(`device:${device.deviceId}`, JSON.stringify(device), { ex: 120 });
  } else {
    await memoryStorage.setDevice(device, 120);
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

export async function enqueueMessageInStore(message: EncryptedMessagePayload): Promise<void> {
  if (redis) {
    // Append to recipient's message queue with 7-day TTL
    await redis.rpush(`queue:${message.recipientDeviceId}`, JSON.stringify(message));
    await redis.expire(`queue:${message.recipientDeviceId}`, 60 * 60 * 24 * 7);
  } else {
    await memoryStorage.enqueueMessage(message);
  }
}

export async function fetchAndClearMessages(recipientDeviceId: string): Promise<EncryptedMessagePayload[]> {
  if (redis) {
    // Atomically pop all waiting messages
    const rawList = await redis.lrange(`queue:${recipientDeviceId}`, 0, -1);
    if (!rawList || rawList.length === 0) return [];
    
    // We clear after reading to uphold minimal retention
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
