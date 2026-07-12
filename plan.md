# VeoClip — Implementation Plan

> A web app that takes a still image as a seed and uses Google Veo to generate a video clip with a voice-over.

---

## 1. Product Overview

**VeoClip** is a single-purpose creative tool. The user uploads a still image, describes what motion/animation they want, writes a voiceover script, and gets back a video clip with narration. VeoClip focuses on a streamlined single-clip workflow.

### Core User Flow

```
Upload Image → Describe Motion → Write Voiceover → Generate → Download/Share
```

### Key Features (MVP)

| Feature | Description |
|---|---|
| Image Upload | Drag-and-drop or file picker for a reference image |
| Video Prompt | Text input describing desired motion/animation |
| Voiceover Script | Text input for narration to be synthesized via TTS |
| Voice Selection | Dropdown to pick a TTS voice |
| Video Duration | Select 5s or 8s clip length |
| Real-time Status | Live progress indicator during generation |
| Preview & Download | In-browser playback + download button for final clip |

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                     Frontend (Next.js)                   │
│  Upload Image → Configure → Generate → Preview/Download  │
└──────────────────┬───────────────────────────────────────┘
                   │  REST API (JSON + multipart)
                   │  Auth: Firebase ID Token (Bearer)
┌──────────────────▼───────────────────────────────────────┐
│                  Backend (Node.js / Express)              │
│                                                          │
│  ┌─────────────┐ ┌─────────────┐ ┌────────────────────┐ │
│  │ Veo Service │ │ TTS Service │ │ FFmpeg Mux Service │ │
│  │ (Vertex AI) │ │ (Cloud TTS) │ │ (video + audio)    │ │
│  └──────┬──────┘ └──────┬──────┘ └────────┬───────────┘ │
│         │               │                 │              │
│  ┌──────▼───────────────▼─────────────────▼───────────┐ │
│  │              Cloud Storage (GCS)                    │ │
│  │  uploads/ | videos/ | audio/ | final/               │ │
│  └────────────────────────────────────────────────────┘ │
│                                                          │
│  ┌────────────────────────────────────────────────────┐  │
│  │           Firestore (job tracking)                 │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Why This Architecture

- **Vertex AI / Veo requires server-side calls** — API keys and service account credentials must not be exposed to the browser.
- **Veo is async** — it returns a Long-Running Operation (LRO) that must be polled. This is best handled server-side.
- **Cloud Storage as media bus** — reference images go in, generated videos and audio come out. Signed URLs give the frontend secure, time-limited access.
- **Firestore for real-time status** — the frontend listens to Firestore document changes to update the UI as generation progresses, avoiding the need for WebSocket infrastructure.

---

## 3. Tech Stack

### Frontend

| Layer | Choice | Rationale |
|---|---|---|
| Framework | **Next.js 15** (App Router) | React-based, SSR for SEO, API routes if needed |
| Styling | **Vanilla CSS** with CSS custom properties | Maximum control, design-system-first |
| Auth | **Firebase Auth** (Google Sign-In)
| Real-time | **Firebase JS SDK** (Firestore `onSnapshot`) | Live status updates without polling |
| Storage | **Firebase Storage SDK** | Direct upload from browser with auth rules |

### Backend

| Layer | Choice | Rationale |
|---|---|---|
| Runtime | **Node.js 20** + **TypeScript** 
| Framework | **Express** 
| AI — Video | **Vertex AI REST API** (Veo `predictLongRunning`) | Direct HTTP calls, no SDK wrapper needed |
| AI — Voice | **@google-cloud/text-to-speech** | Official Node.js SDK |
| Media Mux | **fluent-ffmpeg** | Merge video + voiceover into final clip |
| Storage | **@google-cloud/storage** | Upload/download generated media |
| Database | **Firebase Admin SDK** (Firestore) | Job status tracking, real-time sync |
| Auth | **Firebase Admin SDK** (Auth) | Verify frontend ID tokens |

### Infrastructure

| Component | Service |
|---|---|
| Frontend hosting | Firebase Hosting or Cloud Run |
| Backend hosting | Cloud Run (preferred) or App Engine |
| Media storage | Cloud Storage (single bucket) |
| Database | Firestore |
| CI/CD | Cloud Build |

---

## 4. Data Model

### Firestore: `clips/{clipId}`

```typescript
interface Clip {
  id: string;
  uid: string;                    // Firebase Auth user ID
  createdAt: Timestamp;
  updatedAt: Timestamp;

  // Inputs
  referenceImageUrl: string;      // GCS URL of uploaded image
  videoPrompt: string;            // Describes desired motion
  voiceoverScript: string;        // Text to be spoken
  speakerVoice: string;           // TTS voice name (e.g. "en-US-Journey-D")
  duration: number;               // 5 or 8 seconds

  // Generation status
  status: 'idle' | 'uploading' | 'generating_video' | 'generating_audio' | 'muxing' | 'complete' | 'error';
  error?: string;

  // Outputs
  videoUrl?: string;              // Raw Veo video (no audio)
  audioUrl?: string;              // TTS voiceover audio
  finalUrl?: string;              // Muxed video + audio
}
```

### Cloud Storage Layout

```
gs://{bucket}/
  users/{uid}/clips/{clipId}/
    reference.png          ← uploaded image
    video_raw.mp4          ← Veo output (no audio)
    voiceover.mp3          ← TTS output
    final.mp4              ← muxed video + voiceover
```

### Firestore Security Rules

```javascript
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /clips/{clipId} {
      allow read, write: if request.auth != null
                         && request.auth.uid == resource.data.uid;
      allow create: if request.auth != null
                    && request.resource.data.uid == request.auth.uid;
    }
  }
}
```

### Storage Security Rules

```javascript
rules_version = '2';
service firebase.storage {
  match /b/{bucket}/o {
    match /users/{uid}/{allPaths=**} {
      allow read, write: if request.auth != null
                         && request.auth.uid == uid;
    }
  }
}
```

---

## 5. Backend API Design

### Authentication

All endpoints require `Authorization: Bearer <firebase-id-token>`. Middleware verifies the token with Firebase Admin and attaches the decoded user to the request.

### Endpoints

#### `POST /api/generate`

The main endpoint. Kicks off the full pipeline.

**Request Body:**
```json
{
  "clipId": "abc123",
  "referenceImageUrl": "gs://bucket/users/uid/clips/abc123/reference.png",
  "videoPrompt": "Slow zoom into the forest, birds flying across the sky",
  "voiceoverScript": "In the heart of the ancient woodland, life stirs...",
  "speakerVoice": "en-US-Journey-D",
  "duration": 5
}
```

**Response:** `202 Accepted`
```json
{ "message": "Generation started", "clipId": "abc123" }
```

The endpoint returns immediately. The pipeline runs asynchronously and updates Firestore as it progresses. The frontend listens to Firestore for status changes.

#### `GET /api/clips/:clipId/status`

Fallback status check (if Firestore listener isn't viable).

**Response:**
```json
{
  "status": "generating_video",
  "videoUrl": null,
  "audioUrl": null,
  "finalUrl": null
}
```

#### `GET /api/health`

Health check.

---

## 6. Video Generation Pipeline (Backend)

This is the heart of the app.

```
Step 1: Download reference image from GCS
            │
Step 2: Call Veo predictLongRunning
            │  (send base64 image + video prompt)
            │
Step 3: Poll LRO every 15s until done (~2-5 min)
            │
Step 4: Decode base64 video → upload to GCS
            │  Update Firestore: status = 'generating_audio'
            │
Step 5: Call Cloud TTS with voiceover script
            │  Upload MP3 to GCS
            │  Update Firestore: status = 'muxing'
            │
Step 6: Download video + audio from GCS
            │  FFmpeg: merge into final.mp4
            │  Upload final.mp4 to GCS
            │
Step 7: Update Firestore: status = 'complete', finalUrl = '...'
```

### Veo API Call

```typescript
// POST https://{location}-aiplatform.googleapis.com/v1/projects/{project}/locations/{location}/publishers/google/models/{veoModel}:predictLongRunning

const requestBody = {
  instances: [{
    prompt: videoPrompt,
    image: {
      bytesBase64Encoded: imageBase64,
      mimeType: "image/png"
    }
  }],
  parameters: {
    aspectRatio: "16:9",
    personGeneration: "allow_all",
    durationSeconds: duration,
    sampleCount: 1,
    enhancePrompt: true
  }
};
```

### LRO Polling

```typescript
// GET https://{location}-aiplatform.googleapis.com/v1/{operationName}
// Poll every 15 seconds, timeout after ~10 minutes
// When operation.done === true:
//   video = operation.response.predictions[0].bytesBase64Encoded
```

### FFmpeg Muxing

```bash
ffmpeg -i video_raw.mp4 -i voiceover.mp3 \
  -c:v copy -c:a aac -shortest \
  -map 0:v:0 -map 1:a:0 \
  final.mp4
```

---

## 7. Frontend Design

### Pages

| Route | Component | Purpose |
|---|---|---|
| `/` | Landing | Hero + CTA, shows what the app does |
| `/create` | Creator | Main clip creation interface |
| `/clip/[id]` | Viewer | Preview and download a completed clip |
| `/login` | Auth | Google Sign-In |

### Creator Page Layout

```
┌─────────────────────────────────────────────────────┐
│  VeoClip                              [User Avatar] │
├─────────────────────────────────────────────────────┤
│                                                     │
│  ┌─────────────────────┐  ┌───────────────────────┐│
│  │                     │  │ Video Prompt           ││
│  │   [Image Preview]   │  │ ┌───────────────────┐ ││
│  │                     │  │ │ Describe the       │ ││
│  │   Drop image here   │  │ │ motion you want... │ ││
│  │   or click to browse│  │ └───────────────────┘ ││
│  │                     │  │                       ││
│  └─────────────────────┘  │ Voiceover Script      ││
│                            │ ┌───────────────────┐ ││
│  ┌─ Settings ────────────┐│ │ Write narration... │ ││
│  │ Duration: [5s] [8s]  ││ └───────────────────┘ ││
│  │ Voice: [Dropdown ▾]  │├───────────────────────┤│
│  └───────────────────────┘│                       ││
│                            │  [ ✨ Generate Clip ] ││
│                            └───────────────────────┘│
├─────────────────────────────────────────────────────┤
│  Status: ████████░░░░░ Generating video...          │
├─────────────────────────────────────────────────────┤
│  ┌─────────────────────────────────────────────────┐│
│  │              [Video Player]                     ││
│  │                                                 ││
│  │         ▶  00:00 / 00:05                        ││
│  │                                                 ││
│  └─────────────────────────────────────────────────┘│
│                    [ ⬇ Download ]                   │
└─────────────────────────────────────────────────────┘
```

### Status Indicators

The UI subscribes to Firestore `onSnapshot` for the clip document and shows contextual progress:

| Status | UI |
|---|---|
| `idle` | Ready to generate |
| `uploading` | Uploading image... (spinner) |
| `generating_video` | Generating video with Veo... (animated progress, ~2-5 min) |
| `generating_audio` | Creating voiceover... (spinner) |
| `muxing` | Combining video and audio... (spinner) |
| `complete` | Video player appears with download button |
| `error` | Error message with retry button |

### Design System

- **Dark mode first** — cinematic aesthetic fitting for a video tool
- **Accent color** — electric violet / deep blue gradient
- **Typography** — Inter for UI, monospace for prompts
- **Glassmorphism** panels with subtle backdrop-blur
- **Micro-animations** — smooth status transitions, pulse on generate button, progress shimmer

---

## 8. Project Structure

```
veoclip/
├── frontend/                     # Next.js app
│   ├── src/
│   │   ├── app/
│   │   │   ├── layout.tsx
│   │   │   ├── page.tsx          # Landing page
│   │   │   ├── create/
│   │   │   │   └── page.tsx      # Creator page
│   │   │   ├── clip/
│   │   │   │   └── [id]/
│   │   │   │       └── page.tsx  # Viewer page
│   │   │   └── login/
│   │   │       └── page.tsx
│   │   ├── components/
│   │   │   ├── ImageUpload.tsx
│   │   │   ├── PromptInput.tsx
│   │   │   ├── VoiceSelector.tsx
│   │   │   ├── DurationPicker.tsx
│   │   │   ├── StatusTracker.tsx
│   │   │   ├── VideoPlayer.tsx
│   │   │   └── Navbar.tsx
│   │   ├── hooks/
│   │   │   ├── useClip.ts        # Firestore listener for clip doc
│   │   │   └── useAuth.ts        # Firebase auth state
│   │   ├── lib/
│   │   │   ├── firebase.ts       # Firebase client init
│   │   │   └── api.ts            # Backend API calls
│   │   └── styles/
│   │       └── globals.css       # Design system + global styles
│   ├── public/
│   ├── package.json
│   ├── next.config.ts
│   └── tsconfig.json
│
├── backend/                      # Express API server
│   ├── src/
│   │   ├── server.ts             # Express app entry
│   │   ├── routes/
│   │   │   └── api.ts            # Route definitions
│   │   ├── middleware/
│   │   │   └── auth.ts           # Firebase token verification
│   │   ├── services/
│   │   │   ├── veo.service.ts    # Vertex AI Veo integration
│   │   │   ├── tts.service.ts    # Cloud TTS integration
│   │   │   ├── storage.service.ts # Cloud Storage operations
│   │   │   ├── firestore.service.ts # Firestore operations
│   │   │   └── mux.service.ts    # FFmpeg video+audio merge
│   │   └── types/
│   │       └── clip.ts           # Shared type definitions
│   ├── package.json
│   ├── tsconfig.json
│   ├── Dockerfile
│   └── .env.example
│
├── firebase.json                 # Firebase project config
├── firestore.rules
├── storage.rules
└── README.md
```

---

## 9. Implementation Phases

### Phase 1: Backend Foundation (Days 1-2)
1. Initialize Express + TypeScript project in `backend/`
2. Set up Firebase Admin SDK (Auth + Firestore)
3. Implement auth middleware (verify Firebase ID tokens)
4. Implement `storage.service.ts` (upload/download/signed URLs)
5. Implement `firestore.service.ts` (CRUD for clip documents)
6. Wire up `POST /api/generate` endpoint (skeleton)
7. Test with curl / Postman

### Phase 2: Veo Integration (Days 2-3)
1. Implement `veo.service.ts`:
   - Download reference image from GCS → base64
   - Call `predictLongRunning` endpoint
   - Implement LRO polling loop (15s interval, 10min timeout)
   - Decode result → upload to GCS
   - Update Firestore status at each step
2. Test end-to-end with a test image

### Phase 3: TTS + Muxing (Day 3)
1. Implement `tts.service.ts` (Cloud TTS → MP3 → GCS)
2. Implement `mux.service.ts` (FFmpeg: video + audio → final.mp4)
3. Wire the full pipeline: Veo → TTS → Mux → update Firestore
4. Install FFmpeg in Docker image

### Phase 4: Frontend Foundation (Days 4-5)
1. Initialize Next.js project in `frontend/`
2. Set up Firebase client SDK (Auth + Firestore + Storage)
3. Build the design system in `globals.css` (dark theme, variables, animations)
4. Implement Google Sign-In flow
5. Build `ImageUpload` component (drag-and-drop + preview)
6. Build `PromptInput`, `VoiceSelector`, `DurationPicker` components

### Phase 5: Frontend Generation Flow (Days 5-6)
1. Build the Creator page — assemble all input components
2. Implement image upload to Firebase Storage
3. Implement `POST /api/generate` call with auth token
4. Build `StatusTracker` component with Firestore `onSnapshot` listener
5. Build `VideoPlayer` component for the final clip
6. Implement download functionality

### Phase 6: Polish & Deploy (Day 7)
1. Landing page with hero section and demo
2. Responsive design pass (mobile, tablet, desktop)
3. Error handling and retry UI
4. Loading skeletons and transitions
5. Dockerfile for backend
6. Firebase Hosting config for frontend
7. Cloud Build pipeline

---

## 10. Environment & Prerequisites

### GCP Services to Enable
- Vertex AI API
- Cloud Storage
- Cloud Text-to-Speech API
- Firebase Authentication
- Cloud Firestore
- Cloud Run (or App Engine)
- Cloud Build

### Local Development
```bash
# Backend
cd backend
cp .env.example .env    # Fill in GCP project, bucket, etc.
npm install
npm run dev             # Express on :8080

# Frontend
cd frontend
npm install
npm run dev             # Next.js on :3000 (proxy /api → :8080)
```

### Required Environment Variables
```env
# Backend .env
PORT=8080
GCP_PROJECT_ID=your-project-id
GCP_LOCATION=us-central1
FIREBASE_STORAGE_BUCKET=your-bucket.appspot.com
VEO_MODEL=veo-2.0-generate-001
GOOGLE_APPLICATION_CREDENTIALS=./service-account.json
```

---

## 11. Key Risks & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Veo generation takes 2-5+ min | Users may abandon | Clear progress UI, estimated time remaining, email notification option |
| Veo API rate limits | Generation failures at scale | Queue system, retry with exponential backoff |
| Large video files (~50MB+) | Slow uploads/downloads | Stream from GCS via signed URLs, don't proxy through backend |
| FFmpeg not available in Cloud Run | Muxing fails | Use a container image with FFmpeg pre-installed, or use a Cloud Function with a custom runtime |
| Voiceover doesn't match video length | Audio/video desync | Trim or pad audio to match video duration in FFmpeg |
| Cost per generation | Expensive at scale | Per-user generation limits, usage tracking |

---

## 12. Future Enhancements (Post-MVP)

- **Clip gallery** — user's past generations with thumbnails
- **Style presets** — pre-built motion templates (slow zoom, pan, orbit)
- **Background music** — add ambient music layer under voiceover
- **Aspect ratio options** — 16:9, 9:16 (vertical), 1:1 (square)
- **Batch generation** — generate multiple takes, pick the best
- **Social sharing** — share clips via link with Open Graph previews
- **Prompt suggestions** — AI-powered prompt enhancement based on uploaded image
