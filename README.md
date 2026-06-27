# VidScribe

VidScribe is a Chrome extension that generates timestamped study notes from YouTube videos. The MVP uses YouTube captions as the speech source, selective visible-tab screenshots for visual context, and an AWS Bedrock-backed Fastify server for note generation.

## What Is In This Repo

- `apps/extension` - Chrome Manifest V3 extension with a side panel UI, background service worker, and YouTube content script.
- `apps/server` - Local Fastify API that chunks captions, calls Bedrock, and exposes async note-generation jobs.
- `packages/shared` - Shared Zod schemas and TypeScript types used by both sides.

## Prerequisites

- Node.js 20+
- Chrome 116+
- AWS CLI configured locally
- Bedrock model access enabled for the model you choose

## Local Setup

Install dependencies:

```bash
npm install
```

Create the server env file:

```bash
cp apps/server/.env.example apps/server/.env
```

For a no-cost local flow test, set this in `apps/server/.env`:

```bash
BEDROCK_MOCK=true
```

For real Bedrock calls, keep `BEDROCK_MOCK=false` and make sure your local AWS credentials can invoke the configured model. The server relies on the AWS SDK default credential chain, so `aws configure`, AWS SSO, or environment variables are all valid.

The default model config is:

```bash
AWS_REGION=ap-south-1
BEDROCK_MODEL_ID=global.anthropic.claude-sonnet-4-6
```

## Run The Server

```bash
npm run dev:server
```

Health check:

```bash
curl http://127.0.0.1:8787/health
```

## Build And Load The Extension

In another terminal:

```bash
npm run dev:extension
```

Then in Chrome:

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `apps/extension/dist`.
5. Open a YouTube video with captions.
6. Click the VidScribe toolbar icon to open the side panel.

If you reload the extension during development, refresh the YouTube tab before testing again.

## Build And Test

```bash
npm run build
npm run test
```

## MVP Notes

- Audio transcription is intentionally out of scope. Videos without captions show a clear error.
- Visual support uses user-triggered visible-tab screenshots. It does not decode the full video timeline.
- Generated jobs are in memory only. Restarting the server clears job history.
- The extension sends captions and selected screenshots only to your local server.

## Useful AWS Setup Commands

Configure long-lived dev credentials:

```bash
aws configure
```

Or use AWS SSO if your account is set up that way:

```bash
aws configure sso
aws sso login
```

Check caller identity:

```bash
aws sts get-caller-identity
```

Your AWS principal needs permission for `bedrock:InvokeModel` on the configured model or inference profile.

<img width="1454" height="703" alt="image" src="https://github.com/user-attachments/assets/789b7ba1-219c-43f7-b273-9119fcc185a1" />

