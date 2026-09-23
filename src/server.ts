import Fastify, { FastifyInstance } from 'fastify';
import fastifyCors from '@fastify/cors';
import fastifyWebsocket from '@fastify/websocket';
import jwt from 'jsonwebtoken';
import { WebSocket } from 'ws';
import crypto from 'crypto';
import { sendOtpEmail } from '../lib/email';
import {
  checkRateLimit,
  getOrCreateUser,
  getGroupByCode,
  claimPairingCode,
  generatePairingCodeForGroup,
  registerDeviceInMesh,
  getGroupMembers,
  revokeDeviceFromMesh,
  updateDeviceHeartbeat,
  enqueueMeshMessage,
  peekMeshMessages,
  ackMeshMessage,
  MeshMessageRecord,
} from '../lib/mesh';
import { storeOtp, fetchOtp, removeOtp, isOtpUsed, markOtpUsed } from '../lib/redis';

const JWT_SECRET = process.env.JWT_SECRET || 'devsync-secure-mesh-secret-key-change-in-prod';
const PORT = parseInt(process.env.PORT || '4000', 10);
const HOST = process.env.HOST || '0.0.0.0';

// Active WebSocket connections map: deviceId -> WebSocket
const activeSockets = new Map<string, WebSocket>();
const socketToDevice = new Map<WebSocket, { deviceId: string; groupId: string }>();

export function buildServer(): FastifyInstance {
  const app = Fastify({
    logger: true,
  });

  // CORS
  app.register(fastifyCors, {
    origin: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  // WebSockets
  app.register(fastifyWebsocket);

  // Health Check
  app.get('/api/v1/health', async () => {
    return {
      status: 'healthy',
      activeConnections: activeSockets.size,
      timestamp: Date.now(),
      service: 'devsync-persistent-mesh-server',
    };
  });

  // --- Auth: Request OTP ---
  app.post('/api/v1/auth/request-otp', async (req, reply) => {
    const { email, phone } = (req.body as any) || {};
    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return reply.status(400).send({ error: 'Valid email address is required' });
    }

    const rateKey = `otp_request:${email.toLowerCase().trim()}`;
    const rateCheck = await checkRateLimit(rateKey, 5, 600000);
    if (!rateCheck.allowed) {
      return reply.status(429).send({ error: 'Too many requests. Please try again in 10 minutes.' });
    }

    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    await storeOtp(email, phone || '', otp, 600);

    const emailResult = await sendOtpEmail(email, otp, 'Developer');
    if (!emailResult.success) {
      return reply.status(500).send({ error: `Failed to deliver OTP: ${emailResult.error}` });
    }

    return { success: true, message: 'Verification OTP sent to email' };
  });

  // --- Auth: Verify OTP & Register Device in Mesh ---
  app.post('/api/v1/auth/verify-otp', async (req, reply) => {
    const { email, otp, deviceId, deviceName, platform, signingPublicKey, exchangePublicKey, lanIp, lanPort } = (req.body as any) || {};

    if (!email || !otp || !deviceId) {
      return reply.status(400).send({ error: 'email, otp, and deviceId are required' });
    }

    const cleanEmail = email.toLowerCase().trim();
    const cleanOtp = otp.trim();

    // Check if already used
    if (await isOtpUsed(cleanEmail, cleanOtp)) {
      return reply.status(400).send({ error: 'OTP has already been used' });
    }

    const storedOtpRecord = await fetchOtp(cleanEmail);
    if (!storedOtpRecord) {
      return reply.status(400).send({ error: 'OTP expired or not found. Please request a new one.' });
    }

    if (storedOtpRecord.otp !== cleanOtp) {
      return reply.status(400).send({ error: 'Invalid verification code' });
    }

    // Mark OTP used
    await markOtpUsed(cleanEmail, cleanOtp);
    await removeOtp(cleanEmail);

    // Get or Create User & Device Group
    const { user, group } = await getOrCreateUser(cleanEmail);

    // Register this device in the mesh as Primary
    const { device } = await registerDeviceInMesh(
      {
        deviceId,
        deviceName: deviceName || 'Dev Machine',
        platform: platform || 'unknown',
        signingPublicKey: signingPublicKey || '',
        exchangePublicKey: exchangePublicKey || '',
        lanIp,
        lanPort,
      },
      group.id,
      true // Primary device
    );

    // Generate JWT token bound to device and group
    const token = jwt.sign(
      {
        userId: user.id,
        groupId: group.id,
        deviceId: device.deviceId,
        role: 'PRIMARY',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    return {
      success: true,
      token,
      user: {
        id: user.id,
        email: user.email,
      },
      group: {
        id: group.id,
        connectionCode: group.connectionCode,
        name: group.name,
      },
      device,
    };
  });

  // --- Pairing: Join Group via 6-Digit Connection Code ---
  app.post('/api/v1/devices/pair-request', async (req, reply) => {
    const { connectionCode, deviceId, deviceName, platform, signingPublicKey, exchangePublicKey, lanIp, lanPort } = (req.body as any) || {};

    if (!connectionCode || !deviceId) {
      return reply.status(400).send({ error: 'connectionCode and deviceId are required' });
    }

    const rateKey = `pairing:${deviceId}`;
    const rateCheck = await checkRateLimit(rateKey, 10, 600000);
    if (!rateCheck.allowed) {
      return reply.status(429).send({ error: 'Too many pairing attempts. Please try again later.' });
    }

    // ATOMIC CLAIM: Atomically claims and consumes the pairing code.
    // If multiple devices attempt to pair with the same code concurrently,
    // only the first request succeeds; all others receive null.
    const group = await claimPairingCode(connectionCode);
    if (!group) {
      return reply.status(404).send({ error: 'Invalid, expired, or already used pairing code' });
    }

    // Register device as MEMBER of the group
    const { device } = await registerDeviceInMesh(
      {
        deviceId,
        deviceName: deviceName || 'Dev Device',
        platform: platform || 'unknown',
        signingPublicKey: signingPublicKey || '',
        exchangePublicKey: exchangePublicKey || '',
        lanIp,
        lanPort,
      },
      group.id,
      false // Joined member device
    );

    // Issue JWT token
    const token = jwt.sign(
      {
        userId: group.ownerUserId,
        groupId: group.id,
        deviceId: device.deviceId,
        role: 'MEMBER',
      },
      JWT_SECRET,
      { expiresIn: '30d' }
    );

    // Notify existing connected devices in the group about the new member
    const existingMembers = await getGroupMembers(group.id);
    for (const member of existingMembers) {
      if (member.deviceId !== deviceId) {
        const socket = activeSockets.get(member.deviceId);
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: 'device_joined',
              device,
            })
          );
        }
      }
    }

    return {
      success: true,
      token,
      group: {
        id: group.id,
        connectionCode: group.connectionCode,
        name: group.name,
      },
      device,
      peers: existingMembers.filter((m) => m.deviceId !== deviceId),
    };
  });

  // --- Pairing: Generate Fresh Single-Use Pairing Code ---
  app.post('/api/v1/devices/pairing-code', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Bearer token required' });
    }

    try {
      const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET) as any;
      const { code, expiresAt } = await generatePairingCodeForGroup(decoded.groupId);

      // Notify connected group devices of new code via WebSocket
      const existingMembers = await getGroupMembers(decoded.groupId);
      for (const member of existingMembers) {
        const socket = activeSockets.get(member.deviceId);
        if (socket && socket.readyState === WebSocket.OPEN) {
          socket.send(
            JSON.stringify({
              type: 'pairing_code_updated',
              connectionCode: code,
              expiresAt,
            })
          );
        }
      }

      return {
        success: true,
        connectionCode: code,
        expiresAt,
      };
    } catch (_) {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }
  });

  // --- Network: Ephemeral TURN & STUN Credentials ---
  app.get('/api/v1/network/turn-credentials', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Bearer token required' });
    }

    try {
      const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET) as any;
      const turnSecret = process.env.TURN_SECRET || 'devsync-turn-hmac-secret-change-in-prod';
      const turnUrls = (process.env.TURN_URLS || 'turn:turn.devsync.network:3478,turns:turn.devsync.network:5349').split(',');
      const stunUrls = (process.env.STUN_URLS || 'stun:stun.l.google.com:19302,stun:stun1.l.google.com:19302').split(',');

      const ttl = 3600; // 1 hour
      const expiry = Math.floor(Date.now() / 1000) + ttl;
      const username = `${expiry}:${decoded.deviceId}`;

      const hmac = crypto.createHmac('sha1', turnSecret);
      hmac.update(username);
      const credential = hmac.digest('base64');

      return {
        success: true,
        iceServers: [
          { urls: stunUrls },
          {
            urls: turnUrls,
            username,
            credential,
          },
        ],
        ttl,
        expiresAt: expiry * 1000,
      };
    } catch (_) {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }
  });

  // --- Devices: List Group Members ---
  app.get('/api/v1/devices/group-members', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Bearer token required' });
    }

    try {
      const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET) as any;
      const members = await getGroupMembers(decoded.groupId);
      return {
        success: true,
        groupId: decoded.groupId,
        members: members.map((m) => ({
          ...m,
          isOnline: activeSockets.has(m.deviceId),
        })),
      };
    } catch (_) {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }
  });

  // --- Devices: Revoke Member ---
  app.delete('/api/v1/devices/:deviceId/revoke', async (req, reply) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return reply.status(401).send({ error: 'Bearer token required' });
    }

    try {
      const decoded = jwt.verify(authHeader.substring(7), JWT_SECRET) as any;
      const targetDeviceId = (req.params as any).deviceId;

      // Only PRIMARY or self can revoke
      if (decoded.role !== 'PRIMARY' && decoded.deviceId !== targetDeviceId) {
        return reply.status(403).send({ error: 'Only primary device can revoke peers' });
      }

      const revoked = await revokeDeviceFromMesh(decoded.groupId, targetDeviceId);

      // Force disconnect revoked socket if connected
      const sock = activeSockets.get(targetDeviceId);
      if (sock) {
        sock.send(JSON.stringify({ type: 'revoked', reason: 'Device access revoked' }));
        sock.close();
        activeSockets.delete(targetDeviceId);
      }

      return { success: revoked, revokedDeviceId: targetDeviceId };
    } catch (_) {
      return reply.status(401).send({ error: 'Invalid or expired token' });
    }
  });

  // --- Persistent WebSocket Gateway (/ws) ---
  app.register(async function (fastify) {
    fastify.get('/ws', { websocket: true }, (socket, req) => {
      let authedDeviceId: string | null = null;
      let authedGroupId: string | null = null;

      socket.on('message', async (raw: any) => {
        try {
          const data = JSON.parse(raw.toString());

          // 1. Authenticate Handshake
          if (data.type === 'auth') {
            const token = data.token;
            if (!token) {
              socket.send(JSON.stringify({ type: 'auth_error', error: 'Token missing' }));
              return;
            }

            try {
              const decoded = jwt.verify(token, JWT_SECRET) as any;
              const deviceId = String(decoded.deviceId);
              const groupId = String(decoded.groupId);
              authedDeviceId = deviceId;
              authedGroupId = groupId;

              activeSockets.set(deviceId, socket);
              socketToDevice.set(socket, { deviceId, groupId });

              await updateDeviceHeartbeat(deviceId, true);

              socket.send(
                JSON.stringify({
                  type: 'auth_success',
                  deviceId,
                  groupId,
                })
              );

              // Broadcast presence online to group peers
              broadcastToGroup(groupId, deviceId, {
                type: 'presence_update',
                deviceId,
                isOnline: true,
              });

              // Flush offline messages queued for this device
              const pending = await peekMeshMessages(deviceId);
              if (pending.length > 0) {
                socket.send(
                  JSON.stringify({
                    type: 'offline_messages',
                    messages: pending,
                  })
                );
              }
            } catch (_) {
              socket.send(JSON.stringify({ type: 'auth_error', error: 'Invalid token' }));
              socket.close();
            }
            return;
          }

          if (!authedDeviceId || !authedGroupId) {
            socket.send(JSON.stringify({ type: 'error', error: 'Unauthenticated connection' }));
            return;
          }

          const currentDeviceId = authedDeviceId;
          const currentGroupId = authedGroupId;

          // 2. Delivery Acknowledgment
          if (data.type === 'ack') {
            const messageId = data.messageId;
            if (messageId) {
              await ackMeshMessage(currentDeviceId, messageId);
            }
            return;
          }

          // 3. WebRTC Signaling Dispatch (Polite Peer Pattern)
          if (data.type === 'webrtc_signal') {
            const recipientId = data.recipientDeviceId;
            const targetSocket = activeSockets.get(recipientId);

            const signalPayload = {
              type: 'webrtc_signal',
              senderDeviceId: currentDeviceId,
              recipientDeviceId: recipientId,
              signalType: data.signalType, // 'offer' | 'answer' | 'candidate'
              data: data.data,
              timestamp: Date.now(),
            };

            if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
              targetSocket.send(JSON.stringify(signalPayload));
            } else {
              // Recipient is offline; buffer signaling if offer
              await enqueueMeshMessage({
                id: `sig_${Date.now()}`,
                groupId: currentGroupId,
                senderDeviceId: currentDeviceId,
                recipientDeviceId: recipientId,
                type: 'webrtc_signal',
                cipherText: JSON.stringify(data.data || {}),
                nonce: '',
                mac: '',
                metadata: { signalType: data.signalType },
              });
            }
            return;
          }

          // 4. Encrypted Payload Delivery (Text, Code, File Offer)
          if (data.type === 'message') {
            const recipientId = data.recipientDeviceId;
            const msgRecord: MeshMessageRecord = await enqueueMeshMessage({
              id: data.id || `msg_${Date.now()}`,
              groupId: currentGroupId,
              senderDeviceId: currentDeviceId,
              recipientDeviceId: recipientId,
              type: data.messageType || 'text',
              cipherText: data.cipherText || '',
              nonce: data.nonce || '',
              mac: data.mac || '',
              codeLanguage: data.codeLanguage,
              fileName: data.fileName,
              fileSize: data.fileSize,
              sha256: data.sha256,
              metadata: data.metadata,
            });

            // If recipient is online, push immediately
            const targetSocket = activeSockets.get(recipientId);
            if (targetSocket && targetSocket.readyState === WebSocket.OPEN) {
              targetSocket.send(
                JSON.stringify({
                  type: 'message_incoming',
                  message: msgRecord,
                })
              );
            }

            // Confirm queued to sender
            socket.send(
              JSON.stringify({
                type: 'message_sent',
                id: msgRecord.id,
                delivered: !!(targetSocket && targetSocket.readyState === WebSocket.OPEN),
              })
            );
            return;
          }

          // 5. Broadcast to All Devices in Group
          if (data.type === 'broadcast') {
            broadcastToGroup(currentGroupId, currentDeviceId, {
              type: 'broadcast_incoming',
              senderDeviceId: currentDeviceId,
              payload: data.payload,
              timestamp: Date.now(),
            });
          }
        } catch (err: any) {
          console.error('[WS] Error processing message:', err.message);
        }
      });

      socket.on('close', async () => {
        const info = socketToDevice.get(socket);
        if (info) {
          activeSockets.delete(info.deviceId);
          socketToDevice.delete(socket);
          await updateDeviceHeartbeat(info.deviceId, false);

          // Broadcast offline status to peers
          broadcastToGroup(info.groupId, info.deviceId, {
            type: 'presence_update',
            deviceId: info.deviceId,
            isOnline: false,
          });
        }
      });
    });
  });

  function broadcastToGroup(groupId: string, senderDeviceId: string, payload: any) {
    for (const [devId, sock] of activeSockets.entries()) {
      if (devId !== senderDeviceId && sock.readyState === WebSocket.OPEN) {
        sock.send(JSON.stringify(payload));
      }
    }
  }

  return app;
}

const isEntrypoint = process.argv[1]?.replace(/\\/g, '/').endsWith('/server.ts') || process.argv[1]?.replace(/\\/g, '/').endsWith('/server.js');
if (process.env.NODE_ENV !== 'test' && isEntrypoint) {
  const server = buildServer();
  server.listen({ port: PORT, host: HOST }, (err, address) => {
    if (err) {
      server.log.error(err);
      process.exit(1);
    }
    console.log(`[DevSync Fastify Mesh Server] Running at ${address}`);
    console.log(`[DevSync Fastify Mesh Server] WebSocket Gateway listening at ws://${HOST}:${PORT}/ws`);
  });
}
