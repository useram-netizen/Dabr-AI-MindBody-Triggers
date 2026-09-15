# Mindbody → GoHighLevel Webhook Integration

A small Express server that receives webhook events from Mindbody's Webhooks
API, verifies their signature, and logs them. It currently just logs
incoming events — forwarding to GoHighLevel will be added later.

## What it does right now

- `POST /webhooks/mindbody` — receives Mindbody webhook events, verifies the
  `X-Mindbody-Signature` header, logs the payload, and responds `200 OK`
  immediately.
- `HEAD /webhooks/mindbody` — responds `200 OK`. Mindbody sends a HEAD
  request here when you first create a webhook subscription, to confirm the
  URL is alive.
- `GET /health` — returns `{ "status": "ok" }` so you can confirm the server
  is running.

## 1. Install dependencies

Make sure you have [Node.js](https://nodejs.org/) installed (version 18+
recommended), then from this project folder run:

```
npm install
```

## 2. Configure your environment variables

Copy the example env file:

```
cp .env.example .env
```

(On Windows PowerShell: `Copy-Item .env.example .env`)

Open `.env` and fill in:

- `MINDBODY_WEBHOOK_SECRET` — the shared secret you set when you create the
  webhook subscription in the Mindbody Developer Portal. This must match
  exactly on both sides, or every request will be rejected with `401`.
- `PORT` — optional, defaults to `3000`.

**Never commit your `.env` file.** It's already listed in `.gitignore`.

## 3. Run the server locally

```
npm start
```

You should see:

```
Server listening on port 3000
```

Test the health check in your browser or with curl:

```
curl http://localhost:3000/health
```

You should get back `{"status":"ok"}`.

## 4. Expose your local server publicly (for Mindbody to reach it)

Mindbody's webhook system needs to send requests to a **public HTTPS URL**
— it cannot reach `localhost` on your machine. While developing locally, the
easiest way to get a public URL is [ngrok](https://ngrok.com/), which creates
a secure tunnel from a public address to your local server.

### Install ngrok

Download it from https://ngrok.com/download, or install via a package
manager, e.g.:

```
choco install ngrok
```

(Mac: `brew install ngrok`)

You'll need a free ngrok account and to run `ngrok config add-authtoken <your-token>`
once (get the token from your ngrok dashboard).

### Start the tunnel

With your server already running locally (`npm start`, listening on port
3000), open a **second terminal** and run:

```
ngrok http 3000
```

ngrok will print output like:

```
Forwarding    https://abcd-1234.ngrok-free.app -> http://localhost:3000
```

That `https://abcd-1234.ngrok-free.app` URL is now publicly reachable and
tunnels straight to your local server.

### Register the webhook URL with Mindbody

When creating your webhook subscription in the Mindbody Developer Portal,
use:

```
https://abcd-1234.ngrok-free.app/webhooks/mindbody
```

as the destination URL, and set the same secret there that you put in
`MINDBODY_WEBHOOK_SECRET` in your `.env` file.

Mindbody will first send a `HEAD` request to this URL to confirm it's alive
before activating the subscription — this server already handles that.

### Notes on ngrok

- The free ngrok URL changes every time you restart ngrok, so you'll need to
  update the webhook URL in the Mindbody portal each time — unless you have
  a paid ngrok plan with a reserved/static domain.
- Keep both terminals open (the Node server and ngrok) while testing.
- You can watch incoming requests in real time in the ngrok terminal, and
  also inspect them at `http://127.0.0.1:4040` (ngrok's local web
  inspector) — useful for debugging exactly what Mindbody sent.

## How signature verification works

Mindbody signs each webhook request body using HMAC-SHA256 with your shared
secret, base64-encodes the result, and sends it in the
`X-Mindbody-Signature` header as `sha256=<signature>`.

This server recomputes that same HMAC over the *raw* request body using
`MINDBODY_WEBHOOK_SECRET`, and compares it to the header value using a
timing-safe comparison. If they don't match, the request is rejected with
`401 Unauthorized` and never processed further.

## Next steps

- Add logic to forward `eventData` to GoHighLevel's API after the payload is
  logged (see the `TODO` comment in `server.js`).
- Consider adding retry/queueing if the GoHighLevel forwarding call can be
  slow or unreliable, so the Mindbody response (`200 OK`) never gets delayed
  past the 10-second limit.
