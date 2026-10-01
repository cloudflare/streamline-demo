# Streamline Demo

Streamline Demo is the reference Astro application for [Streamline](https://github.com/cloudflare/streamline). It provides the Cloudflare Worker, Durable Object relay, browser UI, and owner and public Playground deployment profiles.

The demo consumes the released `@cloudflare/streamline` package and a versioned Streamline Container image. Streamline remains independent of this application.

## Requirements

- Node.js 22.12+
- Docker for local Container development
- A Wrangler login with access to the target Cloudflare account
- A published `@cloudflare/streamline` release and a versioned Streamline Container image for deployment

Install dependencies once:

```bash
npm install
```

Direct runtime dependencies are Astro, the Cloudflare Astro adapter and Containers SDK, `@cloudflare/streamline`, `hls.js`, and `jose`. Wrangler, TypeScript, and Astro checking tools are development dependencies.

## Owner Deployment

The owner profile is an Access-protected application with HLS, webcam, and server-managed RTMPS input/output.

### One-Time Setup

1. Create an ignored `.ops/wrangler.jsonc` overlay with the owner Access, hostname, and versioned Container-image values. See [deployment configuration](docs/DEPLOYMENT_CONFIGURATION.md).
2. To create the owner Access application and publisher service token, export a restricted `STREAMLINE_ACCESS_API_TOKEN` with Access Apps/Policies and Service Tokens write permission, then run:

```bash
npm run access:plan
npm run access:prepare
```

`access:prepare` makes the owner application Access-protected and installs the required `PUBLISHER_ACCESS_CLIENT_ID` and `PUBLISHER_ACCESS_CLIENT_SECRET` Worker secrets without printing the secret value. It leaves only the container publisher's narrow `/relay/publish` Access application temporarily on Bypass so its first preview can be verified.

RTMPS is optional. Webcam and public HLS preview work without RTMPS profile secrets. To enable server-managed RTMPS input or output, install either or both profiles interactively:

```bash
env -u CLOUDFLARE_API_TOKEN npx --no-install wrangler secret put MEDIA_RTMP_INPUT_PROFILE --config .ops/wrangler.jsonc
env -u CLOUDFLARE_API_TOKEN npx --no-install wrangler secret put MEDIA_RTMP_OUTPUT_PROFILE --config .ops/wrangler.jsonc
```

Each profile is a one-line JSON object. The input uses a Stream Live Input ID and RTMPS playback key; the output uses a Live Input ID and RTMPS broadcast key:

```json
{"liveInputId":"<LIVE_INPUT_ID>","key":"<RTMPS_KEY>"}
```

### First Deployment

```bash
STREAMLINE_OPS_DIR=.ops npm run secrets:check
STREAMLINE_OPS_DIR=.ops npm run deploy:owner:dry-run
STREAMLINE_OPS_DIR=.ops npm run deploy:owner
```

The deploy command verifies the required publisher secrets, builds Astro, and deploys the Worker against the configured Container image. Sign in through Access and verify a webcam or HLS preview, then lock the publisher path and repeat the preview:

```bash
STREAMLINE_OPS_DIR=.ops npm run access:lock
```

Test RTMPS separately if it is configured.

### Repeat Deployment

After configuration is complete, each source update is a one-command build and deploy:

```bash
STREAMLINE_OPS_DIR=.ops npm run deploy:owner
```

## Playground Deployment

The Playground is a public, rate-limited profile. It accepts webcam and public Cloudflare Stream HLS input and returns browser preview only. It does not expose RTMP credentials, media overrides, metrics, or Probe diagnostics.

### One-Time Setup

1. Configure the public hostname in `ALLOWED_ORIGINS` and `PLAYGROUND_TURNSTILE_HOSTNAMES`. The build derives `MediaContainer.outboundByHost` from those origins.
2. Create a Turnstile widget for that hostname. Install a separate random 32+-character `PLAYGROUND_PRINCIPAL_SECRET`, plus the widget's secret and site key:

```bash
env -u CLOUDFLARE_API_TOKEN npx --no-install wrangler secret put PLAYGROUND_PRINCIPAL_SECRET --env playground --config .ops/wrangler.jsonc
env -u CLOUDFLARE_API_TOKEN npx --no-install wrangler secret put PLAYGROUND_TURNSTILE_SECRET --env playground --config .ops/wrangler.jsonc
env -u CLOUDFLARE_API_TOKEN npx --no-install wrangler secret put PLAYGROUND_TURNSTILE_SITEKEY --env playground --config .ops/wrangler.jsonc
```

### First Deployment

```bash
STREAMLINE_OPS_DIR=.ops npm run deploy:playground:dry-run
STREAMLINE_OPS_DIR=.ops npm run deploy:playground
```

The profile remains fail-closed until all three secrets are present. It admits verified Turnstile sessions, limits active Containers globally, and applies fixed public media limits. Complete a browser Turnstile admission and webcam or public-HLS preview smoke test after deployment.

### Repeat Deployment

After configuration is complete, each source update is a one-command build and deploy:

```bash
STREAMLINE_OPS_DIR=.ops npm run deploy:playground
```

## Local Development

```bash
npm test
npm run typecheck
STREAMLINE_CONTAINER_SOURCE=../streamline/container npm run dev:container
```

`dev:container` builds and starts a local Container source directory, waits for its health endpoint, then starts Astro. Set `STREAMLINE_CONTAINER_IMAGE` instead to run an already local image. Use `.env.example` only for local RTMPS test credentials; never commit real keys.

## Documentation

- [Streamline architecture](https://github.com/cloudflare/streamline/blob/main/ARCHITECTURE.md): media flow, security boundaries, and session model.
- [Session API contract](https://github.com/cloudflare/streamline/blob/main/docs/SESSION_API_CONTRACT.md): reusable Worker and Durable Object integration.
- [`@cloudflare/streamline`](https://www.npmjs.com/package/@cloudflare/streamline): package API.
- [Contributing](CONTRIBUTING.md) and [security reporting](SECURITY.md).
