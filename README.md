# VidScribe

VidScribe generates structured, timestamped study notes from YouTube videos. It currently has a Chrome MV3 extension, an Expo React Native mobile app, a Fastify backend, and shared TypeScript/Zod contracts. The backend chunks captions, calls AWS Bedrock, and exposes async note-generation jobs that both clients can poll.

The project is captions-first. It supports manual and auto-generated captions where YouTube exposes usable caption tracks. Audio transcription is intentionally out of scope for the current MVP.

## What Is In This Repo

- `apps/extension` - Chrome Manifest V3 extension with a side panel UI, background service worker, and YouTube content script.
- `apps/mobile` - Expo React Native app for generating notes from pasted or shared YouTube URLs.
- `apps/server` - Fastify API that extracts YouTube captions, chunks transcripts, calls Bedrock, and tracks async note jobs in memory.
- `packages/shared` - Shared Zod schemas and TypeScript types for videos, captions, frames, note documents, jobs, and YouTube URL requests.

## How It Works

### Chrome extension flow

1. Open a YouTube watch page.
2. The side panel asks the content script to extract video metadata and captions.
3. The content script tries YouTube caption tracks across multiple formats: provided format, `json3`, `srv3`, `srv1`, and `vtt`.
4. It supports manual and auto-generated captions, with fallback attempts through the page, extension service worker, and transcript panel metadata.
5. It samples visible frames around visual cue timestamps for optional context.
6. The side panel sends captions and selected frames to the server.
7. The server chunks captions, calls Bedrock, and returns progress through the job polling API.

### Mobile app flow

1. Paste a YouTube URL or share one into VidScribe mobile.
2. The mobile app sends the URL to the backend.
3. The backend parses the video id, loads YouTube player data, chooses the best caption track, and fetches caption text.
4. The backend creates the same async note job used by the extension, with `frames: []`.
5. The mobile app polls job status, renders notes, and can copy/share Markdown.
6. Generated notes are stored in local mobile history through AsyncStorage.

Mobile v1 does not capture YouTube frames because React Native cannot inject into or screenshot the YouTube app/browser like the Chrome extension can.

## Tech Stack

- TypeScript
- npm workspaces
- Chrome Manifest V3
- React + Vite for the extension side panel
- Expo + React Native for mobile
- Fastify for the backend API
- Zod for shared runtime validation
- AWS SDK for JavaScript v3 with Bedrock Runtime
- `fast-xml-parser` and server-side caption parsers for YouTube caption formats
- Vitest for server tests

## Prerequisites

- Node.js 20+
- Chrome 116+ for extension development
- Expo Go or a simulator/device for mobile development
- AWS CLI configured locally for real Bedrock calls
- Bedrock model access enabled for the configured model

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

Default model config:

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

For a physical mobile device on the same Wi-Fi network, bind the server to all interfaces:

```bash
HOST=0.0.0.0 npm run dev:server
```

## Run The Chrome Extension

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

## Run The Mobile App

For an iOS simulator or Android emulator that can reach `127.0.0.1:8787`:

```bash
npm run dev:mobile
```

For a physical device, point the app at your machine's LAN IP:

```bash
EXPO_PUBLIC_API_BASE_URL=http://YOUR_LAN_IP:8787 npm run dev:mobile
```

Then open the app through Expo Go or your simulator. Paste a YouTube URL, or share a YouTube link into VidScribe if the platform share/deep-link flow is available.

## API Surface

### Health

```http
GET /health
```

### Create notes from extracted captions

Used by the Chrome extension after it has already extracted captions and optional visual frames.

```http
POST /api/notes/jobs
```

Body shape:

```json
{
  "video": {
    "id": "VIDEO_ID",
    "title": "Video title",
    "duration": 600,
    "url": "https://www.youtube.com/watch?v=VIDEO_ID"
  },
  "captions": [
    {
      "start": 0,
      "end": 4.5,
      "text": "Caption text"
    }
  ],
  "frames": []
}
```

### Create notes from a YouTube URL

Used by the mobile app. The server performs caption extraction.

```http
POST /api/notes/youtube/jobs
```

Body shape:

```json
{
  "url": "https://www.youtube.com/watch?v=VIDEO_ID",
  "preferredLanguage": "en"
}
```

`preferredLanguage` is optional.

### Poll a note job

```http
GET /api/notes/jobs/:jobId
```

Job statuses:

- `queued`
- `running`
- `completed`
- `partial`
- `failed`

Jobs are stored in memory only. Restarting the server clears job history.

## Build And Test

Run everything:

```bash
npm run test
npm run build
```

Run individual workspaces:

```bash
npm run build:server
npm run build:extension
npm run build:mobile
```

The root `test` script builds `@vidscribe/shared` first so runtime schemas are current before server tests run.

## AWS Setup

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

## Current Limitations

- Videos without readable captions fail with a clear error.
- Audio transcription is not implemented yet.
- Mobile does not include visual frame extraction in v1.
- YouTube caption extraction is best-effort because YouTube response formats and access checks can change.
- Server jobs are in-memory only.
- The Chrome extension sends captions and selected screenshots only to the configured local/server API.

## Useful Debugging Notes

- For Chrome caption issues, inspect console lines prefixed with `[VidScribe]`.
- Common useful signals include caption track count, attempted caption format, empty caption response, and transcript fallback errors.
- If mobile cannot reach the backend on a real device, use `HOST=0.0.0.0` for the server and `EXPO_PUBLIC_API_BASE_URL=http://YOUR_LAN_IP:8787` for Expo.

<img width="1454" height="703" alt="image" src="https://github.com/user-attachments/assets/789b7ba1-219c-43f7-b273-9119fcc185a1" />