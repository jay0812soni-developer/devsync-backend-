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

export interface EncryptedMessagePayload {
  id: string;
  senderDeviceId: string;
  recipientDeviceId: string;
  type: 'text' | 'code' | 'file_offer' | 'status_update';
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
