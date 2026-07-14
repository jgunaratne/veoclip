import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
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
import { generateStory, generatePresenterScript, generateCharacterProfile, generateMusicPrompt, SAFE_FALLBACK_SCENE } from '../services/story.service.js';
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
import { generateBackgroundMusic } from '../services/music.service.js';

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

// Formats that Veo doesn't accept — convert these to JPEG after upload.
const CONVERT_EXTENSIONS = new Set(['.avif', '.webp', '.heic', '.heif', '.tiff', '.tif']);

/**
 * If the uploaded file is in a format Veo can't consume (e.g. AVIF),
 * convert it to JPEG using sharp and return the new path.
 * Otherwise return the original path unchanged.
 */
async function ensureJpeg(filePath: string): Promise<string> {
  const ext = path.extname(filePath).toLowerCase();
  if (!CONVERT_EXTENSIONS.has(ext)) return filePath;

  const jpegPath = filePath.replace(/\.[^.]+$/, '.jpg');
  await sharp(filePath).jpeg({ quality: 90 }).toFile(jpegPath);

  // Remove the original to avoid clutter
  await fs.unlink(filePath).catch(() => {});

  console.log(`[upload] Converted ${path.basename(filePath)} → ${path.basename(jpegPath)}`);
  return jpegPath;
}

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

// Suggest a narrator character profile based on the pasted source text
apiRouter.post('/suggest-character', async (req: Request, res: Response) => {
  const { storyText } = req.body;
  if (!storyText || typeof storyText !== 'string' || !storyText.trim()) {
    res.status(400).json({ error: 'storyText is required' });
    return;
  }
  try {
    const profile = await generateCharacterProfile(storyText);
    res.json({ characterProfile: profile });
  } catch (err) {
    console.error('[api] Character suggestion failed:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Suggest a music prompt based on the pasted source text
apiRouter.post('/suggest-music-prompt', async (req: Request, res: Response) => {
  const { storyText } = req.body;
  if (!storyText || typeof storyText !== 'string' || !storyText.trim()) {
    res.status(400).json({ error: 'storyText is required' });
    return;
  }
  try {
    const musicPrompt = await generateMusicPrompt(storyText);
    res.json({ musicPrompt });
  } catch (err) {
    console.error('[api] Music prompt suggestion failed:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Create a new clip (multipart: image files + text fields)
apiRouter.post(
  '/clips',
  upload.array('images', MAX_IMAGES),
  async (req: Request, res: Response) => {
    try {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];

      const { storyText, speakerVoice, length, ensureContinuity, characterProfile, enableMusic, enableNarration, mode } = req.body;

      if (!storyText || !storyText.trim()) {
        res.status(400).json({ error: 'storyText is required' });
        return;
      }

      const parsedLength = Number(length) as StoryLength;
      if (!SEGMENT_COUNTS[parsedLength]) {
        res.status(400).json({ error: 'length must be 30, 60 or 180' });
        return;
      }

      // Convert any non-JPEG/PNG uploads (AVIF, WEBP, HEIC, etc.) to JPEG
      const imagePaths = await Promise.all(
        files.map((f) => ensureJpeg(f.path)),
      );

      const clip: Clip = {
        id: uuidv4(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        storyText,
        referenceImagePaths: imagePaths,
        speakerVoice: speakerVoice || getDefaultVoice(),
        characterProfile: characterProfile?.trim() || undefined,
        enableMusic: enableMusic === 'true' || enableMusic === true,
        enableNarration: enableNarration !== 'false' && enableNarration !== false,
        length: parsedLength,
        ensureContinuity: ensureContinuity === 'true' || ensureContinuity === true,
        mode: mode === 'presenter' ? 'presenter' : 'story',
        status: 'idle',
      };

      setClip(clip);
      res.status(201).json(clip);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[api] Failed to create clip:', message);
      res.status(500).json({ error: message });
    }
  },
);

// Generate story script without running the full pipeline
apiRouter.post('/clips/:id/script', async (req: Request, res: Response) => {
  const clip = getClip(req.params.id as string);
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  if (clip.status !== 'idle' && clip.status !== 'error') {
    res.status(409).json({ error: `Clip is already ${clip.status}` });
    return;
  }

  try {
    const segmentCount = SEGMENT_COUNTS[clip.length];
    updateClip(clip.id, { status: 'preparing_script' });

    if (clip.mode === 'presenter') {
      // Presenter mode: generate narration only, use uniform talking-head prompt
      const presenterResult = await generatePresenterScript({
        storyText: clip.storyText,
        targetSeconds: clip.length,
      });

      const presenterPrompt =
        'A person casually talking to camera like they are recording a social media video. ' +
        'Solid bright green chroma key screen background. Natural casual lighting. ' +
        'Relaxed, expressive, and animated — like filming a TikTok or Instagram Reel. ' +
        'No transitions, no fades, no cuts, no camera movement, no zoom. Static locked-off camera. ' +
        'Continuous uninterrupted shot from start to finish. ' +
        'No background noise, no music, no background sound effects. Clear spoken voice only. Dead silent background environment.';

      updateClip(clip.id, {
        narrationScript: presenterResult.narrationScript,
        scenePrompts: Array.from({ length: segmentCount }, () => presenterPrompt),
        caption: presenterResult.caption || undefined,
        status: 'script_ready',
      });
    } else {
      // Story mode: generate narration + per-scene visual prompts
      const story = await generateStory({
        storyText: clip.storyText,
        imagePaths: clip.referenceImagePaths,
        targetSeconds: clip.length,
        segmentCount,
      });

      updateClip(clip.id, {
        narrationScript: story.narrationScript,
        scenePrompts: story.scenes.map((s) => s.prompt),
        caption: story.caption || undefined,
        status: 'script_ready',
      });
    }

    res.json(getClip(clip.id));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[api] Script generation failed for clip ${clip.id}:`, message);
    updateClip(clip.id, { status: 'error', error: message });
    res.status(500).json({ error: message });
  }
});

// Start the generation pipeline (async — returns 202 immediately)
apiRouter.post('/clips/:id/generate', (req: Request, res: Response) => {
  const clip = getClip(req.params.id as string);
  if (!clip) {
    res.status(404).json({ error: 'Clip not found' });
    return;
  }

  if (clip.status !== 'idle' && clip.status !== 'error' && clip.status !== 'script_ready') {
    res.status(409).json({ error: `Clip is already ${clip.status}` });
    return;
  }

  // If the user sent an edited narrationScript or musicPrompt, store them before launching
  const { narrationScript: narrationOverride, musicPrompt: musicPromptOverride } = req.body ?? {};
  if (narrationOverride && typeof narrationOverride === 'string') {
    updateClip(clip.id, { narrationScript: narrationOverride });
  }
  if (musicPromptOverride && typeof musicPromptOverride === 'string') {
    updateClip(clip.id, { musicPrompt: musicPromptOverride });
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
    let story: { narrationScript: string; scenes: { prompt: string }[]; caption?: string };
    const freshClip = getClip(clipId)!;

    if (freshClip.narrationScript && freshClip.scenePrompts && freshClip.scenePrompts.length > 0) {
      // Script was pre-generated (or user-edited) — reuse stored data
      console.log(`[pipeline] Reusing pre-generated script for clip ${clipId}`);
      story = {
        narrationScript: freshClip.narrationScript,
        scenes: freshClip.scenePrompts.map((prompt) => ({ prompt })),
        caption: freshClip.caption,
      };
      updateClip(clipId, { status: 'generating_video', totalSegments: segmentCount });
    } else {
      updateClip(clipId, { status: 'preparing_script', totalSegments: segmentCount });

      story = await generateStory({
        storyText: clip.storyText,
        imagePaths: clip.referenceImagePaths,
        targetSeconds: clip.length,
        segmentCount,
      });

      updateClip(clipId, {
        narrationScript: story.narrationScript,
        scenePrompts: story.scenes.map((s) => s.prompt),
        caption: story.caption || undefined,
        status: 'generating_video',
      });
    }

    // ── Step 2: Generate Veo segments (Sequential vs Parallel) ──────
    const seedAssignments = assignSeedImages(
      clip.referenceImagePaths,
      segmentCount,
    );

    // For presenter mode, use the single face image for ALL segments
    // and embed narration text into each scene prompt
    if (clip.mode === 'presenter' && clip.referenceImagePaths.length > 0) {
      seedAssignments.clear();
      const faceImage = clip.referenceImagePaths[0];
      for (let i = 0; i < segmentCount; i++) {
        seedAssignments.set(i, faceImage);
      }
    }

    if (clip.mode === 'presenter') {
      // Split narration into equal-length chunks by word count, ensuring every segment gets text
      const words = story.narrationScript.split(/\s+/).filter(Boolean);
      const totalWords = words.length;
      const wordsPerSegment = Math.max(1, Math.floor(totalWords / segmentCount));
      const segmentTexts: string[] = [];

      for (let i = 0; i < segmentCount; i++) {
        const start = i * wordsPerSegment;
        const end = i === segmentCount - 1 ? totalWords : (i + 1) * wordsPerSegment;
        const chunk = words.slice(start, end).join(' ');
        segmentTexts.push(chunk);
      }

      // Merge any trailing empty segments into the last non-empty one
      while (segmentTexts.length > 1 && !segmentTexts[segmentTexts.length - 1]) {
        segmentTexts.pop();
      }

      for (let i = 0; i < Math.min(story.scenes.length, segmentCount); i++) {
        // If we have text for this segment, use it; otherwise repeat the last chunk
        const segText = segmentTexts[i] || segmentTexts[segmentTexts.length - 1] || story.narrationScript;
        story.scenes[i] = {
          prompt:
            'A person casually talking to camera like they are recording a social media video. ' +
            'Solid bright green chroma key screen background. Natural casual lighting. ' +
            'Relaxed, expressive, and animated — like filming a TikTok or Instagram Reel. ' +
            'No transitions, no fades, no cuts, no camera movement, no zoom. Static locked-off camera. ' +
            'Continuous uninterrupted shot from start to finish. ' +
            'No background noise, no music, no background sound effects. Clear spoken voice only. Dead silent background environment. ' +
            `The person says out loud: "${segText}"`,
        };
      }
      console.log(`[pipeline] Presenter mode: embedded narration into ${segmentCount} segment(s), ${totalWords} words total, ~${wordsPerSegment} words/segment`);
    }

    // Ensure ALL clips are generated on a green screen background
    const GREEN_SCREEN_SUFFIX =
      ' The entire background MUST be a solid, uniform bright green chroma key screen (#00FF00). ' +
      'No other background elements, scenery, or environments — only a flat green screen behind the subject.';
    for (let i = 0; i < story.scenes.length; i++) {
      story.scenes[i].prompt += GREEN_SCREEN_SUFFIX;
    }

    const segmentPaths: string[] = [];
    const useContinuity = clip.ensureContinuity || clip.mode === 'presenter';

    if (useContinuity) {
      console.log(`[pipeline] Generating segments sequentially with continuity chaining`);
      let chainedSeedPath: string | null = null;

      for (let seg = 0; seg < Math.min(story.scenes.length, segmentCount); seg++) {
        updateClip(clipId, { currentSegment: seg + 1 });
        console.log(
          `[pipeline] Generating segment ${seg + 1}/${segmentCount} sequentially for clip ${clipId}`,
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
          console.log(
            `[pipeline] Segment ${seg + 1} filtered (${err.message}); retrying with sanitized prompt`,
          );
          segVideoPath = await generateVideo({
            imagePath: seedImagePath,
            prompt: SAFE_FALLBACK_SCENE + GREEN_SCREEN_SUFFIX,
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
    } else {
      console.log(`[pipeline] Generating segments in parallel (continuity chaining disabled)`);
      updateClip(clipId, { currentSegment: 0 });

      let completedCount = 0;
      const tasks = Array.from({ length: Math.min(story.scenes.length, segmentCount) }).map(
        async (_, seg) => {
          // In parallel mode, only user-assigned seed images are used (no chained frames)
          const seedImagePath = seedAssignments.get(seg) ?? null;
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
            console.log(
              `[pipeline] Segment ${seg + 1} filtered (${err.message}); retrying with sanitized prompt`,
            );
            segVideoPath = await generateVideo({
              imagePath: seedImagePath,
              prompt: SAFE_FALLBACK_SCENE + GREEN_SCREEN_SUFFIX,
              duration: SEGMENT_DURATION,
              outputDir,
              clipId: `${clipId}_seg${seg}`,
            });
          }

          completedCount++;
          updateClip(clipId, { currentSegment: completedCount });
          console.log(`[pipeline] Parallel segment ${seg + 1}/${segmentCount} complete`);
          return { seg, path: segVideoPath };
        },
      );

      const results = await Promise.all(tasks);
      // Ensure segment paths are sorted by their original segment index
      results.sort((a, b) => a.seg - b.seg);
      segmentPaths.push(...results.map((r) => r.path));
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

    // Save videoPath on the clip and clear segment counter
    updateClip(clipId, { videoPath, currentSegment: undefined });

    // For presenter mode, the Veo video already contains speech — skip TTS/music/mux
    if (clip.mode === 'presenter') {
      console.log(`[pipeline] Presenter mode: skipping TTS/music, using Veo output directly`);
      updateClip(clipId, { finalPath: videoPath, status: 'complete' });
      console.log(`[pipeline] Clip ${clipId} complete!`);
      return;
    }

    let audioPath: string | undefined = undefined;
    const narrationEnabled = clip.enableNarration !== false;

    if (narrationEnabled) {
      updateClip(clipId, { status: 'generating_audio' });
      console.log(`[pipeline] Video done, generating narration audio for clip ${clipId}`);

      // ── Step 3: Narration voiceover ────────────────────────────────────
      audioPath = await generateVoiceover({
        script: story.narrationScript,
        voice: clip.speakerVoice,
        characterProfile: clip.characterProfile,
        outputDir,
        clipId,
      });

      updateClip(clipId, { audioPath });
    } else {
      console.log(`[pipeline] Video done, voiceover narration is disabled for clip ${clipId}`);
    }

    // ── Step 4: Background music (best-effort) ────────────────────────
    let backgroundMusicPath: string | null = null;
    if (clip.enableMusic) {
      updateClip(clipId, { status: 'generating_music' });
      console.log(`[pipeline] Generating background music for clip ${clipId}`);

      // Re-fetch clip to pick up any user-edited music prompt
      const clipForMusic = getClip(clipId)!;
      const videoDuration = segmentCount * SEGMENT_DURATION;
      backgroundMusicPath = await generateBackgroundMusic({
        narrationScript: story.narrationScript,
        musicPrompt: clipForMusic.musicPrompt,
        videoDuration,
        outputDir,
        clipId,
      }).catch((err) => {
        console.warn(`[pipeline] Background music generation failed (non-fatal): ${(err as Error).message}`);
        return null;
      });
    }

    // ── Step 5: Mux video + narration + music ─────────────────────────
    updateClip(clipId, { status: 'muxing' });
    console.log(`[pipeline] Muxing for clip ${clipId}${backgroundMusicPath ? ' (with background music)' : ''}`);

    const finalPath = await muxVideoAudio({
      videoPath,
      audioPath,
      backgroundMusicPath: backgroundMusicPath ?? undefined,
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
