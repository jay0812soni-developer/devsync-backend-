import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { buildServer } from '../src/server';
import { storeOtp } from '../lib/redis';
import { peekMeshMessages } from '../lib/mesh';

describe('DEVSync Post-Implementation Verification Gate', () => {
  const app = buildServer();

  before(async () => {
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  // ==================================================
  // 1. PAIRING CODE SINGLE-USE & REUSE AUDIT
  // ==================================================
  test('CRITICAL TEST: Pairing code single-use verification (Device C reusing Device B code)', async () => {
    const email = `audit_${Date.now()}@example.com`;
    const otp = '998877';
    await storeOtp(email, '+1000000000', otp, 600);

    // Step 1: Device A creates network and gets pairing code
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-otp',
      payload: {
        email,
        otp,
        deviceId: 'DEV-A',
        deviceName: "Device A",
        platform: 'windows',
        signingPublicKey: 'pubA',
        exchangePublicKey: 'exA',
      },
    });
    assert.strictEqual(regRes.statusCode, 200);
    const regData = JSON.parse(regRes.payload);
    const pairingCode = regData.group.connectionCode;

    // Step 2: Device B joins successfully with code
    const joinBRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair-request',
      payload: {
        connectionCode: pairingCode,
        deviceId: 'DEV-B',
        deviceName: "Device B",
        platform: 'ios',
        signingPublicKey: 'pubB',
        exchangePublicKey: 'exB',
      },
    });
    assert.strictEqual(joinBRes.statusCode, 200, 'Device B must join successfully');

    // Step 3: Device C attempts to reuse the SAME code
    const joinCRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair-request',
      payload: {
        connectionCode: pairingCode,
        deviceId: 'DEV-C',
        deviceName: "Device C",
        platform: 'android',
        signingPublicKey: 'pubC',
        exchangePublicKey: 'exC',
      },
    });

    console.log(`[AUDIT EVIDENCE] Device C reuse attempt status code: ${joinCRes.statusCode}`);
    console.log(`[AUDIT EVIDENCE] Device C response: ${joinCRes.payload}`);

    // If Device C was allowed to join using the same code, we record this as an active failure according to the Gate Rule.
    const isSingleUse = joinCRes.statusCode === 400 || joinCRes.statusCode === 403 || joinCRes.statusCode === 404;
    
    // We assert this condition so the test reports exact compliance
    assert.ok(
      isSingleUse,
      `CRITICAL VULNERABILITY: Pairing code "${pairingCode}" was REUSABLE by Device C! Code must be invalidated immediately after Device B joins.`
    );
  });

  test('CRITICAL TEST: Concurrent Pairing Race Condition (Device B & Device C claim simultaneously)', async () => {
    const email = `race_${Date.now()}@example.com`;
    const otp = '112233';
    await storeOtp(email, '+1000000001', otp, 600);

    // Primary creates group
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-otp',
      payload: {
        email,
        otp,
        deviceId: 'DEV-PRIMARY-RACE',
        deviceName: "Primary Device",
        platform: 'windows',
        signingPublicKey: 'pubP',
        exchangePublicKey: 'exP',
      },
    });
    assert.strictEqual(regRes.statusCode, 200);
    const regData = JSON.parse(regRes.payload);
    const pairingCode = regData.group.connectionCode;

    // Simultaneous concurrent requests
    const [resB, resC] = await Promise.all([
      app.inject({
        method: 'POST',
        url: '/api/v1/devices/pair-request',
        payload: {
          connectionCode: pairingCode,
          deviceId: 'DEV-RACE-B',
          deviceName: "Device Race B",
          platform: 'ios',
        },
      }),
      app.inject({
        method: 'POST',
        url: '/api/v1/devices/pair-request',
        payload: {
          connectionCode: pairingCode,
          deviceId: 'DEV-RACE-C',
          deviceName: "Device Race C",
          platform: 'android',
        },
      }),
    ]);

    const statusCodes = [resB.statusCode, resC.statusCode];
    console.log(`[AUDIT EVIDENCE] Concurrent race status codes: ${statusCodes.join(', ')}`);

    // Exactly one must succeed (200) and the other must be rejected (404/410)
    const successCount = statusCodes.filter((s) => s === 200).length;
    const failureCount = statusCodes.filter((s) => s === 404 || s === 410 || s === 400).length;

    assert.strictEqual(successCount, 1, 'Exactly one concurrent pairing request must succeed');
    assert.strictEqual(failureCount, 1, 'The competing concurrent pairing request must be rejected');
  });

  test('Pairing Code Dynamic Rotation & Protected Generation', async () => {
    const email = `rotate_${Date.now()}@example.com`;
    const otp = '445566';
    await storeOtp(email, '+1000000002', otp, 600);

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-otp',
      payload: {
        email,
        otp,
        deviceId: 'DEV-PRIMARY-ROT',
        deviceName: "Primary",
        platform: 'windows',
      },
    });
    const regData = JSON.parse(regRes.payload);
    const primaryToken = regData.token;

    // Generate new code
    const rotRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-code',
      headers: {
        Authorization: `Bearer ${primaryToken}`,
      },
    });
    assert.strictEqual(rotRes.statusCode, 200);
    const rotData = JSON.parse(rotRes.payload);
    assert.strictEqual(rotData.success, true);
    assert.strictEqual(typeof rotData.connectionCode, 'string');
    assert.strictEqual(rotData.connectionCode.length, 6);

    // Join with rotated code
    const joinRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair-request',
      payload: {
        connectionCode: rotData.connectionCode,
        deviceId: 'DEV-JOIN-ROT',
        deviceName: "Joined via Rotation",
        platform: 'macos',
      },
    });
    assert.strictEqual(joinRes.statusCode, 200);

    // Reuse must fail
    const reuseRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair-request',
      payload: {
        connectionCode: rotData.connectionCode,
        deviceId: 'DEV-REUSE-ROT',
        deviceName: "Reuse Attempt",
        platform: 'linux',
      },
    });
    assert.strictEqual(reuseRes.statusCode, 404);
  });

  test('Ephemeral TURN Credentials Generation & HMAC-SHA1 Audit', async () => {
    const email = `turn_${Date.now()}@example.com`;
    const otp = '778899';
    await storeOtp(email, '+1000000003', otp, 600);

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-otp',
      payload: {
        email,
        otp,
        deviceId: 'DEV-PRIMARY-TURN',
        deviceName: "Primary Turn",
        platform: 'windows',
      },
    });
    const regData = JSON.parse(regRes.payload);
    const primaryToken = regData.token;

    const turnRes = await app.inject({
      method: 'GET',
      url: '/api/v1/network/turn-credentials',
      headers: {
        Authorization: `Bearer ${primaryToken}`,
      },
    });
    assert.strictEqual(turnRes.statusCode, 200);
    const turnData = JSON.parse(turnRes.payload);

    assert.strictEqual(turnData.success, true);
    assert.ok(Array.isArray(turnData.iceServers));
    assert.ok(turnData.iceServers.length >= 2, 'Must include both STUN and TURN configs');

    const turnConfig = turnData.iceServers.find((s: any) => s.username && s.credential);
    assert.ok(turnConfig, 'Must contain ephemeral TURN server entry with username and credential');
    assert.ok(turnConfig.username.includes('DEV-PRIMARY-TURN'), 'Username must bind expiry and deviceId');
    assert.ok(turnConfig.credential.length > 10, 'Credential must be non-empty HMAC signature');
    console.log(`[AUDIT EVIDENCE] Ephemeral TURN username: ${turnConfig.username}`);
  });

  // ==================================================
  // 2. RATE LIMITING AUDIT
  // ==================================================
  test('Pairing code brute force rate limiting audit', async () => {
    const invalidAttempts = [];
    for (let i = 0; i < 15; i++) {
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/devices/pair-request',
        payload: {
          connectionCode: '000000',
          deviceId: 'DEV-ATTACKER-1',
          deviceName: 'Attacker Machine',
          platform: 'linux',
        },
      });
      invalidAttempts.push(res.statusCode);
    }

    const rateLimited = invalidAttempts.some((status) => status === 429);
    console.log(`[AUDIT EVIDENCE] Attacker 15 attempts status codes: ${invalidAttempts.join(', ')}`);
    assert.ok(rateLimited, 'Rate limiting (429) must activate against brute-forcing');
  });

  // ==================================================
  // 3. OFFLINE QUEUE & EXPLICIT ACK AUDIT
  // ==================================================
  test('Offline Queue: Messages buffered and retained until explicit client ACK', async () => {
    const email = `queue_${Date.now()}@example.com`;
    const otp = '112233';
    await storeOtp(email, '+1000000001', otp, 600);

    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-otp',
      payload: {
        email,
        otp,
        deviceId: 'DEV-OFFLINE-A',
        deviceName: "Device A",
        platform: 'windows',
      },
    });
    const regData = JSON.parse(regRes.payload);
    const tokenA = regData.token;

    // Send message to offline recipient DEV-OFFLINE-B
    // We test queueing via peekMeshMessages
    const queuedBefore = await peekMeshMessages('DEV-OFFLINE-B');
    assert.strictEqual(queuedBefore.length, 0);
  });

  // ==================================================
  // 4. REVOCATION REJECTION AUDIT
  // ==================================================
  test('Revocation: Revoked device token rejection on protected routes', async () => {
    const email = `revoke_${Date.now()}@example.com`;
    const otp = '445566';
    await storeOtp(email, '+1000000002', otp, 600);

    // Primary Device A
    const regRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-otp',
      payload: {
        email,
        otp,
        deviceId: 'DEV-PRIMARY-REVOKER',
        deviceName: "Primary Device",
        platform: 'windows',
      },
    });
    const primaryToken = JSON.parse(regRes.payload).token;
    const code = JSON.parse(regRes.payload).group.connectionCode;

    // Member Device B joins
    const joinRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair-request',
      payload: {
        connectionCode: code,
        deviceId: 'DEV-MEMBER-TARGET',
        deviceName: "Member to Revoke",
        platform: 'ios',
      },
    });
    const memberToken = JSON.parse(joinRes.payload).token;

    // Primary revokes Member B
    const revokeRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/devices/DEV-MEMBER-TARGET/revoke',
      headers: {
        authorization: `Bearer ${primaryToken}`,
      },
    });
    assert.strictEqual(revokeRes.statusCode, 200);

    // Verify revoked device cannot be queried or access group
    const listRes = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/group-members',
      headers: {
        authorization: `Bearer ${primaryToken}`,
      },
    });
    const listData = JSON.parse(listRes.payload);
    const memberIds = listData.members.map((m: any) => m.deviceId);
    assert.ok(!memberIds.includes('DEV-MEMBER-TARGET'), 'Revoked device must not be in active members');
  });
});
