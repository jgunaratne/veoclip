import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import type { Clip, StoryLength } from '../types/clip.js';
import { SEGMENT_COUNTS, SEGMENT_DURATION } from '../types/clip.js';
import {
  getClip,
  setClip,
  updateClip,
  getAllClips,
  deleteClip,
  subscribeToClip,
} from '../store.js';
import { generateVideo, VideoFilteredError } from '../services/veo.service.js';
import { generateStory, SAFE_FALLBACK_SCENE } from '../services/story.service.js';
import {
  generateVoiceover,
  getAvailableVoices,
  getDefaultVoice,
} from '../services/tts.service.js';
import {
  muxVideoAudio,
  concatenateVideos,
  extractLastFrame,
} from '../services/mux.service.js';

// ---------------------------------------------------------------------------
// Multer setup
// ---------------------------------------------------------------------------

const uploadDir = process.env.UPLOAD_DIR || './uploads';
const outputDir = process.env.OUTPUT_DIR || './output';

const MAX_IMAGES = 8;

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${uuidv4()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25 MB per image
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

// List available voices (depends on the configured auth mode)
apiRouter.get('/voices', (_req: Request, res: Response) => {
  res.json(getAvailableVoices());
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

// Create a new clip (multipart: image files + text fields)
apiRouter.post(
  '/clips',
  upload.array('images', MAX_IMAGES),
  (req: Request, res: Response) => {
    const files = (req.files as Express.Multer.File[] | undefined) ?? [];

    const { storyText, speakerVoice, length } = req.body;

    if (!storyText || !storyText.trim()) {
      res.status(400).json({ error: 'storyText is required' });
      return;
    }

    const parsedLength = Number(length) as StoryLength;
    if (!SEGMENT_COUNTS[parsedLength]) {
      res.status(400).json({ error: 'length must be 30, 60 or 180' });
      return;
    }

    const clip: Clip = {
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      storyText,
      referenceImagePaths: files.map((f) => f.path),
      speakerVoice: speakerVoice || getDefaultVoice(),
      length: parsedLength,
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
    ...clip.referenceImagePaths,
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

// ---------------------------------------------------------------------------
// Async generation pipeline
// ---------------------------------------------------------------------------

/**
 * Spread the user's reference images across the story's segments so each
 * image anchors a stretch of the video. Segment 0 always gets the first
 * image; segments without an assigned image chain from the previous
 * segment's last frame.
 */
function assignSeedImages(
  imagePaths: string[],
  segmentCount: number,
): Map<number, string> {
  const seeds = new Map<number, string>();
  if (imagePaths.length === 0) return seeds;

  const usable = imagePaths.slice(0, segmentCount);
  for (let j = 0; j < usable.length; j++) {
    const segmentIndex = Math.round((j * segmentCount) / usable.length);
    seeds.set(Math.min(segmentIndex, segmentCount - 1), usable[j]);
  }
  return seeds;
}

async function runPipeline(clipId: string): Promise<void> {
  try {
    const clip = getClip(clipId)!;
    const segmentCount = SEGMENT_COUNTS[clip.length];

    console.log(
      `[pipeline] Starting story generation for clip ${clipId}: ` +
        `${clip.length}s target = ${segmentCount} segment(s), ` +
        `${clip.referenceImagePaths.length} reference image(s)`,
    );

    // ── Step 1: Write the story (narration + scene prompts) ──────────
    updateClip(clipId, { status: 'preparing_script', totalSegments: segmentCount });

    const story = await generateStory({
      storyText: clip.storyText,
      imagePaths: clip.referenceImagePaths,
      targetSeconds: clip.length,
      segmentCount,
    });

    updateClip(clipId, {
      narrationScript: story.narrationScript,
      scenePrompts: story.scenes.map((s) => s.prompt),
      status: 'generating_video',
    });

    // ── Step 2: Generate Veo segments with frame chaining ────────────
    const seedAssignments = assignSeedImages(
      clip.referenceImagePaths,
      segmentCount,
    );

    const segmentPaths: string[] = [];
    let chainedSeedPath: string | null = null;

    for (let seg = 0; seg < Math.min(story.scenes.length, segmentCount); seg++) {
      updateClip(clipId, { currentSegment: seg + 1 });
      console.log(
        `[pipeline] Generating segment ${seg + 1}/${segmentCount} for clip ${clipId}`,
      );

      // A user image assigned to this slot wins over the chained frame
      const seedImagePath = seedAssignments.get(seg) ?? chainedSeedPath;

      const scenePrompt = story.scenes[seg].prompt;
      let segVideoPath: string;
      try {
        segVideoPath = await generateVideo({
          imagePath: seedImagePath,
          prompt: scenePrompt,
          duration: SEGMENT_DURATION,
          outputDir,
          clipId: `${clipId}_seg${seg}`,
        });
      } catch (err) {
        if (!(err instanceof VideoFilteredError)) throw err;
        // Don't let one filtered scene sink the whole run —
        // retry once with a deliberately safe abstract prompt.
        console.log(
          `[pipeline] Segment ${seg + 1} filtered (${err.message}); retrying with sanitized prompt`,
        );
        segVideoPath = await generateVideo({
          imagePath: seedImagePath,
          prompt: SAFE_FALLBACK_SCENE,
          duration: SEGMENT_DURATION,
          outputDir,
          clipId: `${clipId}_seg${seg}`,
        });
      }

      segmentPaths.push(segVideoPath);

      // Extract last frame for chaining (unless this is the last segment)
      if (seg < segmentCount - 1) {
        try {
          chainedSeedPath = await extractLastFrame({
            videoPath: segVideoPath,
            outputDir,
            clipId,
            segmentIndex: seg,
          });
        } catch {
          console.warn(
            `[pipeline] Couldn't extract last frame of segment ${seg + 1}; next segment won't be chained`,
          );
          chainedSeedPath = null;
        }
      }
    }

    // Concatenate segments if we have more than one
    let videoPath: string;
    if (segmentPaths.length > 1) {
      videoPath = await concatenateVideos({
        videoPaths: segmentPaths,
        outputDir,
        clipId,
      });
    } else {
      videoPath = segmentPaths[0];
    }

    updateClip(clipId, {
      videoPath,
      status: 'generating_audio',
      currentSegment: undefined,
    });
    console.log(`[pipeline] Video done, generating narration audio for clip ${clipId}`);

    // ── Step 3: Narration voiceover ───────────────────────────────────
    const audioPath = await generateVoiceover({
      script: story.narrationScript,
      voice: clip.speakerVoice,
      outputDir,
      clipId,
    });

    // ── Step 4: Mux video + narration ─────────────────────────────────
    updateClip(clipId, { audioPath, status: 'muxing' });
    console.log(`[pipeline] Audio done, muxing for clip ${clipId}`);

    const finalPath = await muxVideoAudio({
      videoPath,
      audioPath,
      outputDir,
      clipId,
    });

    updateClip(clipId, { finalPath, status: 'complete' });
    console.log(`[pipeline] Clip ${clipId} complete!`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[pipeline] Error for clip ${clipId}:`, message);
    updateClip(clipId, { status: 'error', error: message });
  }
}
