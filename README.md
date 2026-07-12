# VeoClip

A web app that takes a still image and generates a video clip with voiceover using Google Veo and Cloud Text-to-Speech.

## Architecture

- **Frontend**: Next.js 15 (App Router) with Firebase Auth, Firestore real-time listeners, and Firebase Storage
- **Backend**: Express + TypeScript with Vertex AI (Veo), Cloud TTS, FFmpeg, and Firebase Admin

## Prerequisites

- Node.js 20+
- FFmpeg installed locally (`brew install ffmpeg` on macOS)
- A Google Cloud project with Vertex AI, Cloud TTS, Cloud Storage, and Firebase enabled
- Firebase project with Auth (Google provider) and Firestore enabled
- Service account key with appropriate permissions

## Setup

### Backend

```bash
cd backend
cp .env.example .env   # Fill in your GCP project details
npm install
npm run dev            # Starts on http://localhost:8080
```

### Frontend

```bash
cd frontend
cp .env.example .env.local   # Fill in your Firebase config
npm install
npm run dev                  # Starts on http://localhost:3000
```

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
