export interface DeviceRegistration {
  deviceId: string;
  deviceName: string;
  platform: string;
  signingPublicKey: string;
  exchangePublicKey: string;
  lanIp?: string;
  lanPort?: number;
  timestamp: number;
}

export interface UserAccount {
  email: string;
  phone: string;
  primaryDeviceId: string;
  connectionCode: string; // 6-digit persistent code e.g. "492817"
  createdAt: number;
  updatedAt: number;
}

export interface OtpRecord {
  email: string;
  phone: string;
  otp: string;
  expiresAt: number;
  attempts: number;
}

export interface PairedConnection {
  connectionCode: string;
  primaryDevice: DeviceRegistration;
  secondaryDevice?: DeviceRegistration;
  createdAt: number;
  pairedAt?: number;
}

export interface EncryptedMessagePayload {
  id: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  type: 'text' | 'code' | 'file_offer' | 'status_update' | 'device_paired';
  cipherText: string;
  nonce: string;
  mac: string;
  codeLanguage?: string;
  fileName?: string;
  fileSize?: number;
  sha256?: string;
  timestamp: number;
}

export interface DeliveryAck {
  messageId: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  status: 'delivered' | 'read';
  timestamp: number;
}
