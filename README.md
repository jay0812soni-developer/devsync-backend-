# DevSync Vercel Relay Backend

This is the lightweight, zero-retention serverless message relay server for **DevSync**.

## Features
- **Stateless & Serverless**: Runs completely on Vercel Edge / Serverless functions.
- **Server-Sent Events (SSE)**: Streams encrypted messages to devices in real time (`GET /api/events`).
- **Zero-Retention**: Messages are deleted from the server queue immediately upon delivery confirmation (`POST /api/messages/ack`).
- **End-to-End Encrypted**: Payloads are encrypted with AES-256-GCM on-device before hitting this backend. The server cannot inspect message contents.
- **Upstash Redis Integration**: Free serverless Redis for pub/sub and queueing across serverless invocations. Includes built-in memory fallback for local testing.

## Deployment to Vercel

### Step 1: Clone or Navigate to `backend-vercel`
```bash
cd backend-vercel
npm install
```

### Step 2: (Optional) Set up free Upstash Redis
1. Create a free account at [upstash.com](https://upstash.com).
2. Create a serverless Redis database.
3. Copy `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`.

### Step 3: Deploy to Vercel
```bash
npx vercel
```
During setup, set the Environment Variables:
- `UPSTASH_REDIS_REST_URL`
- `UPSTASH_REDIS_REST_TOKEN`

Once deployed, copy your deployment URL (e.g. `https://devsync-relay-xyz.vercel.app`) and configure it inside the DevSync Flutter app settings.
