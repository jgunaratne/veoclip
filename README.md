# VeoClip

A web app that turns pasted text and a few images into a narrated story video, built for social media. Pick a length (30 s / 1 min / 3 min); Gemini writes a narration script and per-scene prompts, Veo generates chained 8-second vertical (9:16) segments seeded from your images, and the result is stitched, voiced, and muxed into a single MP4.

## How it works

```
Paste text + add images → Gemini writes story (narration + N scene prompts)
  → N × 8 s Veo segments (your images anchor scenes; others chain from the
    previous segment's last frame)
  → FFmpeg concat → TTS narration → FFmpeg mux → final vertical MP4
```

Lengths map to segment counts: 30 s → 4 scenes, 1 min → 8 scenes, 3 min → 23 scenes. Expect roughly 1–4 minutes of generation time per scene.

## Architecture

- **Frontend**: Next.js (App Router), SSE for live pipeline status
- **Backend**: Express + TypeScript with Veo (Gemini API or Vertex AI), Gemini for story/script generation, Gemini TTS or Cloud TTS, and FFmpeg (bundled — no system install needed)

## Prerequisites

- Node.js 20+
- A Gemini API key (preferred — latest models; get one at https://aistudio.google.com/apikey), **or** a Google Cloud project with Vertex AI + Cloud TTS enabled

## Setup

```bash
cp backend/.env.example backend/.env   # Set GEMINI_API_KEY (or GCP project details)
npm install                            # Installs root + backend + frontend deps
npm start                              # Starts backend (:8080) and frontend (:3000)
```

Or run each side individually with `npm run dev` inside `backend/` or `frontend/`.

## Project Structure

```
veoclip/
├── frontend/          # Next.js app
├── backend/           # Express API server
├── firebase.json      # Firebase project config
├── firestore.rules    # Firestore security rules
├── storage.rules      # Cloud Storage security rules
└── plan.md            # Implementation plan
```
