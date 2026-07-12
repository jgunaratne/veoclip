import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type { Clip } from '../types/clip.js';
import {
  getClip,
  setClip,
  updateClip,
  getAllClips,
  deleteClip,
  subscribeToClip,
} from '../store.js';
import { generateVideo } from '../services/veo.service.js';
import { generateVoiceover } from '../services/tts.service.js';
import { muxVideoAudio } from '../services/mux.service.js';

// ---------------------------------------------------------------------------
// Available TTS voices
// ---------------------------------------------------------------------------

const VOICES = [
  { id: 'en-US-Journey-D', name: 'Journey D (Male)', gender: 'MALE' },
  { id: 'en-US-Journey-F', name: 'Journey F (Female)', gender: 'FEMALE' },
  { id: 'en-US-Journey-O', name: 'Journey O (Female)', gender: 'FEMALE' },
  { id: 'en-US-Casual-K', name: 'Casual K (Male)', gender: 'MALE' },
  { id: 'en-US-Neural2-A', name: 'Neural2 A (Male)', gender: 'MALE' },
  { id: 'en-US-Neural2-C', name: 'Neural2 C (Female)', gender: 'FEMALE' },
  { id: 'en-US-Neural2-D', name: 'Neural2 D (Male)', gender: 'MALE' },
  { id: 'en-US-Neural2-F', name: 'Neural2 F (Female)', gender: 'FEMALE' },
  { id: 'en-US-Studio-M', name: 'Studio M (Male)', gender: 'MALE' },
  { id: 'en-US-Studio-O', name: 'Studio O (Female)', gender: 'FEMALE' },
];

// ---------------------------------------------------------------------------
// Multer setup
// ---------------------------------------------------------------------------

const uploadDir = process.env.UPLOAD_DIR || './uploads';
const outputDir = process.env.OUTPUT_DIR || './output';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Only image files are accepted'));
    }
  },
});

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const apiRouter = Router();

// Health check
apiRouter.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// List available voices
apiRouter.get('/voices', (_req: Request, res: Response) => {
  res.json(VOICES);
});

// List all clips
apiRouter.get('/clips', (_req: Request, res: Response) => {
  res.json(getAllClips());
});

// Get a single clip
apiRouter.get('/clips/:id', (req: Request, res: Response) => {
  const clip = getClip(req.params.id as string);
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }
  res.json(clip);
});

// Create a new clip (multipart: image file + text fields)
apiRouter.post(
  '/clips',
  upload.single('image'),
  (req: Request, res: Response) => {
    const file = req.file;
    if (!file) {
      res.status(400).json({ error: 'Image file is required' });
      return;
    }

    const { videoPrompt, voiceoverScript, speakerVoice, duration } = req.body;

    if (!videoPrompt) {
      res.status(400).json({ error: 'videoPrompt is required' });
      return;
    }

    const clip: Clip = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      referenceImagePath: file.path,
      videoPrompt,
      voiceoverScript: voiceoverScript || '',
      speakerVoice: speakerVoice || 'en-US-Journey-D',
      duration: Number(duration) || 5,
      status: 'idle',
    };

    setClip(clip);
    res.status(201).json(clip);
  },
);

// Start the generation pipeline (async — returns 202 immediately)
apiRouter.post('/clips/:id/generate', (req: Request, res: Response) => {
  const clip = getClip(req.params.id as string);
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  if (clip.status !== 'idle' && clip.status !== 'error') {
    res.status(409).json({ error: `Clip is already ${clip.status}` });
    return;
  }

  // Return immediately
  res.status(202).json({ message: 'Generation started', clipId: clip.id });

  // Run pipeline async (fire-and-forget)
  runPipeline(clip.id).catch((err) => {
    console.error(`[pipeline] Fatal error for clip ${clip.id}:`, err);
  });
});

// SSE endpoint for real-time clip status updates
apiRouter.get('/clips/:id/events', (req: Request, res: Response) => {
  const clip = getClip(req.params.id as string);
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  // Send current state immediately
  res.write(`data: ${JSON.stringify(clip)}\n\n`);

  // Subscribe to updates
  subscribeToClip(clip.id, res);
});

// Delete a clip and its files
apiRouter.delete('/clips/:id', async (req: Request, res: Response) => {
  const clip = getClip(req.params.id as string);
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  // Clean up files
  const filePaths = [
    clip.referenceImagePath,
    clip.videoPath,
    clip.audioPath,
    clip.finalPath,
  ].filter(Boolean) as string[];

  for (const filePath of filePaths) {
    try {
      await fs.unlink(filePath);
    } catch {
      // File may not exist — that's fine
    }
  }

  deleteClip(clip.id);
  res.status(204).send();
});

import { concatenateVideos, extractLastFrame } from '../services/mux.service.js';

// ---------------------------------------------------------------------------
// Async generation pipeline
// ---------------------------------------------------------------------------

async function runPipeline(clipId: string): Promise<void> {
  try {
    const clip = getClip(clipId)!;

    // Determine how many segments we need (max 8s per Veo call)
    const segmentDuration = 8;
    const totalDuration = clip.duration;
    const segmentCount = Math.ceil(totalDuration / segmentDuration);

    console.log(
      `[pipeline] Starting generation for clip ${clipId}: ${totalDuration}s = ${segmentCount} segment(s)`,
    );
    updateClip(clipId, { status: 'generating_video' });

    const segmentPaths: string[] = [];
    let seedImagePath = clip.referenceImagePath;

    for (let seg = 0; seg < segmentCount; seg++) {
      const isLastSegment = seg === segmentCount - 1;
      // Last segment may be shorter
      const dur = isLastSegment
        ? totalDuration - seg * segmentDuration
        : segmentDuration;

      console.log(
        `[pipeline] Generating segment ${seg + 1}/${segmentCount} (${dur}s) for clip ${clipId}`,
      );

      const segVideoPath = await generateVideo({
        imagePath: seedImagePath,
        prompt: clip.videoPrompt,
        duration: dur >= 5 ? dur : 5, // Veo minimum is 5s
        outputDir,
        clipId: `${clipId}_seg${seg}`,
        onStatusChange: () => {},
      });

      segmentPaths.push(segVideoPath);

      // Extract last frame for chaining (unless this is the last segment)
      if (!isLastSegment) {
        seedImagePath = await extractLastFrame({
          videoPath: segVideoPath,
          outputDir,
          clipId,
          segmentIndex: seg,
        });
      }
    }

    // Concatenate segments if we have more than one
    let videoPath: string;
    if (segmentPaths.length > 1) {
      updateClip(clipId, { status: 'muxing' }); // reuse muxing status for concat
      videoPath = await concatenateVideos({
        videoPaths: segmentPaths,
        outputDir,
        clipId,
      });
    } else {
      videoPath = segmentPaths[0];
    }

    updateClip(clipId, { videoPath, status: 'generating_audio' });
    console.log(`[pipeline] Video done, generating audio for clip ${clipId}`);

    // Generate voiceover with TTS
    let audioPath: string | undefined;
    if (clip.voiceoverScript && clip.voiceoverScript.trim().length > 0) {
      audioPath = await generateVoiceover({
        script: clip.voiceoverScript,
        voice: clip.speakerVoice,
        outputDir,
        clipId,
      });
    }

    // Mux video + audio (if audio exists)
    if (audioPath) {
      updateClip(clipId, { audioPath, status: 'muxing' });
      console.log(`[pipeline] Audio done, muxing for clip ${clipId}`);

      const finalPath = await muxVideoAudio({
        videoPath,
        audioPath,
        outputDir,
        clipId,
      });

      updateClip(clipId, { finalPath, status: 'complete' });
    } else {
      // No voiceover — the raw video IS the final video
      updateClip(clipId, { finalPath: videoPath, status: 'complete' });
    }

    console.log(`[pipeline] Clip ${clipId} complete!`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Error for clip ${clipId}:`, message);
    updateClip(clipId, { status: 'error', error: message });
  }
}
