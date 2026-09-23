import { test, describe, before, after } from 'node:test';
import assert from 'node:assert';
import { buildServer } from '../src/server';
import { storeOtp } from '../lib/redis';

describe('DEVSync Persistent Fastify Mesh Server Tests', () => {
  const app = buildServer();

  before(async () => {
    await app.ready();
  });

  after(async () => {
    await app.close();
  });

  test('GET /api/v1/health returns healthy status and active connection count', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/health',
    });

    assert.strictEqual(res.statusCode, 200);
    const json = JSON.parse(res.payload);
    assert.strictEqual(json.status, 'healthy');
    assert.strictEqual(typeof json.activeConnections, 'number');
    assert.strictEqual(json.service, 'devsync-persistent-mesh-server');
  });

  test('Full Multi-Device Registration & Pairing Flow', async () => {
    const testEmail = `dev_${Date.now()}@example.com`;
    const testOtp = '123456';
    await storeOtp(testEmail, '+1234567890', testOtp, 600);

    // 1. Primary Device Registers via OTP
    const primaryRes = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/verify-otp',
      payload: {
        email: testEmail,
        otp: testOtp,
        deviceId: 'DEV-PRIMARY-1',
        deviceName: "Jay's Laptop",
        platform: 'windows',
        signingPublicKey: 'primary-signing-pub',
        exchangePublicKey: 'primary-exchange-pub',
      },
    });

    assert.strictEqual(primaryRes.statusCode, 200);
    const primaryData = JSON.parse(primaryRes.payload);
    assert.strictEqual(primaryData.success, true);
    assert.ok(primaryData.token, 'Primary device should receive JWT');
    assert.strictEqual(primaryData.device.deviceId, 'DEV-PRIMARY-1');
    assert.strictEqual(primaryData.group.connectionCode.length, 6);

    const primaryToken = primaryData.token;
    const connectionCode = primaryData.group.connectionCode;

    // 2. Secondary Device (e.g. Phone) Joins via Connection Code
    const secondaryRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair-request',
      payload: {
        connectionCode,
        deviceId: 'DEV-PHONE-2',
        deviceName: "Jay's iPhone",
        platform: 'ios',
        signingPublicKey: 'phone-signing-pub',
        exchangePublicKey: 'phone-exchange-pub',
      },
    });

    assert.strictEqual(secondaryRes.statusCode, 200);
    const secondaryData = JSON.parse(secondaryRes.payload);
    assert.strictEqual(secondaryData.success, true);
    assert.ok(secondaryData.token, 'Secondary device should receive JWT');
    assert.strictEqual(secondaryData.device.deviceId, 'DEV-PHONE-2');
    assert.strictEqual(secondaryData.peers.length, 1);
    assert.strictEqual(secondaryData.peers[0].deviceId, 'DEV-PRIMARY-1');

    // 3. Primary generates a fresh single-use code for Tertiary Device (e.g. Tablet)
    const code2Res = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pairing-code',
      headers: {
        authorization: `Bearer ${primaryToken}`,
      },
    });
    assert.strictEqual(code2Res.statusCode, 200);
    const code2Data = JSON.parse(code2Res.payload);
    const connectionCode2 = code2Data.connectionCode;

    // Tertiary Device joins via fresh single-use connection code (N-Device verification)
    const tertiaryRes = await app.inject({
      method: 'POST',
      url: '/api/v1/devices/pair-request',
      payload: {
        connectionCode: connectionCode2,
        deviceId: 'DEV-TABLET-3',
        deviceName: "Jay's iPad",
        platform: 'ios',
        signingPublicKey: 'tablet-signing-pub',
        exchangePublicKey: 'tablet-exchange-pub',
      },
    });

    assert.strictEqual(tertiaryRes.statusCode, 200);
    const tertiaryData = JSON.parse(tertiaryRes.payload);
    assert.strictEqual(tertiaryData.success, true);
    assert.strictEqual(tertiaryData.device.deviceId, 'DEV-TABLET-3');
    // Tablet sees both primary and secondary devices in peers list
    assert.strictEqual(tertiaryData.peers.length, 2);

    // 4. Primary Device Fetches Group Members
    const membersRes = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/group-members',
      headers: {
        authorization: `Bearer ${primaryToken}`,
      },
    });

    assert.strictEqual(membersRes.statusCode, 200);
    const membersData = JSON.parse(membersRes.payload);
    assert.strictEqual(membersData.success, true);
    assert.strictEqual(membersData.members.length, 3);
    const deviceIds = membersData.members.map((m: any) => m.deviceId);
    assert.ok(deviceIds.includes('DEV-PRIMARY-1'));
    assert.ok(deviceIds.includes('DEV-PHONE-2'));
    assert.ok(deviceIds.includes('DEV-TABLET-3'));

    // 5. Revocation of Secondary Device
    const revokeRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/devices/DEV-PHONE-2/revoke',
      headers: {
        authorization: `Bearer ${primaryToken}`,
      },
    });

    assert.strictEqual(revokeRes.statusCode, 200);
    const revokeData = JSON.parse(revokeRes.payload);
    assert.strictEqual(revokeData.success, true);
    assert.strictEqual(revokeData.revokedDeviceId, 'DEV-PHONE-2');

    // 6. Verify Revoked Device is no longer listed in active members
    const membersAfterRevoke = await app.inject({
      method: 'GET',
      url: '/api/v1/devices/group-members',
      headers: {
        authorization: `Bearer ${primaryToken}`,
      },
    });
    const afterData = JSON.parse(membersAfterRevoke.payload);
    assert.strictEqual(afterData.members.length, 2);
    assert.ok(!afterData.members.map((m: any) => m.deviceId).includes('DEV-PHONE-2'));
  });
});
