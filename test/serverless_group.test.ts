import { test, describe } from 'node:test';
import assert from 'node:assert';
import { storeOtp } from '../lib/redis';
import verifyOtpHandler from '../api/auth/verify-otp';
import pairDeviceHandler from '../api/auth/pair-device';
import groupMembersHandler from '../api/v1/devices/group-members';

function createMockReqRes(options: {
  method: string;
  body?: any;
  query?: any;
  headers?: any;
}) {
  const req: any = {
    method: options.method,
    body: options.body || {},
    query: options.query || {},
    headers: options.headers || {},
  };

  const res: any = {
    statusCode: 200,
    headers: {},
    data: null,
    setHeader(key: string, value: string) {
      this.headers[key.toLowerCase()] = value;
      return this;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(data: any) {
      this.data = data;
      return this;
    },
    end() {
      return this;
    },
  };

  return { req, res };
}

describe('Serverless N-Device Mesh Group & Roster Tests', () => {
  test('N-Device Mesh: Device 1 registers, Device 2 joins, Device 3 joins, all see each other', async () => {
    const testEmail = `mesh_${Date.now()}@example.com`;
    const testOtp = '654321';
    await storeOtp(testEmail, '+919999999999', testOtp, 600);

    // 1. Device 1 (Primary: Dell Desktop) registers via verify-otp
    const { req: req1, res: res1 } = createMockReqRes({
      method: 'POST',
      body: {
        email: testEmail,
        otp: testOtp,
        deviceId: 'DEV-DELL-DESKTOP',
        deviceName: 'Dell Desktop',
        platform: 'windows',
        signingPublicKey: 'sig-key-1',
        exchangePublicKey: 'exc-key-1',
      },
    });
    await verifyOtpHandler(req1, res1);

    assert.strictEqual(res1.statusCode, 200);
    assert.strictEqual(res1.data.success, true);
    const connectionCode = res1.data.connectionCode;
    const token1 = res1.data.token;
    assert.ok(connectionCode, 'Should return connectionCode');
    assert.ok(token1, 'Should return token');

    // 2. Device 2 (Secondary: Android Phone) pairs with connectionCode
    const { req: req2, res: res2 } = createMockReqRes({
      method: 'POST',
      body: {
        connectionCode,
        deviceId: 'DEV-ANDROID-PHONE',
        deviceName: 'Android Phone',
        platform: 'android',
        signingPublicKey: 'sig-key-2',
        exchangePublicKey: 'exc-key-2',
      },
    });
    await pairDeviceHandler(req2, res2);

    assert.strictEqual(res2.statusCode, 200);
    assert.strictEqual(res2.data.success, true);
    const token2 = res2.data.token;
    assert.ok(token2, 'Device 2 should receive JWT token');
    // Device 2's peers must contain Device 1
    assert.strictEqual(res2.data.peers.length, 1);
    assert.strictEqual(res2.data.peers[0].deviceId, 'DEV-DELL-DESKTOP');

    // 3. Device 3 (Secondary: iPad Tablet) pairs with same connectionCode
    const { req: req3, res: res3 } = createMockReqRes({
      method: 'POST',
      body: {
        connectionCode,
        deviceId: 'DEV-IPAD-TABLET',
        deviceName: 'iPad Tablet',
        platform: 'ios',
        signingPublicKey: 'sig-key-3',
        exchangePublicKey: 'exc-key-3',
      },
    });
    await pairDeviceHandler(req3, res3);

    assert.strictEqual(res3.statusCode, 200);
    assert.strictEqual(res3.data.success, true);
    const token3 = res3.data.token;
    assert.ok(token3, 'Device 3 should receive JWT token');
    // Device 3's peers must contain BOTH Device 1 AND Device 2!
    assert.strictEqual(res3.data.peers.length, 2);
    const dev3PeerIds = res3.data.peers.map((p: any) => p.deviceId);
    assert.ok(dev3PeerIds.includes('DEV-DELL-DESKTOP'));
    assert.ok(dev3PeerIds.includes('DEV-ANDROID-PHONE'));

    // 4. Device 2 calls GET /api/v1/devices/group-members using token2
    const { req: reqRoster2, res: resRoster2 } = createMockReqRes({
      method: 'GET',
      headers: {
        authorization: `Bearer ${token2}`,
      },
    });
    await groupMembersHandler(reqRoster2, resRoster2);

    assert.strictEqual(resRoster2.statusCode, 200);
    assert.strictEqual(resRoster2.data.success, true);
    assert.strictEqual(resRoster2.data.members.length, 3);
    const memberIds2 = resRoster2.data.members.map((m: any) => m.deviceId);
    assert.ok(memberIds2.includes('DEV-DELL-DESKTOP'));
    assert.ok(memberIds2.includes('DEV-ANDROID-PHONE'));
    assert.ok(memberIds2.includes('DEV-IPAD-TABLET'));

    // 5. Query fallback: call GET /api/v1/devices/group-members with ?code=
    const { req: reqRosterQuery, res: resRosterQuery } = createMockReqRes({
      method: 'GET',
      query: { code: connectionCode },
    });
    await groupMembersHandler(reqRosterQuery, resRosterQuery);

    assert.strictEqual(resRosterQuery.statusCode, 200);
    assert.strictEqual(resRosterQuery.data.members.length, 3);
  });
});
