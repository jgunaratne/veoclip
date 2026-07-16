import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import type { Clip, StoryLength, PresenterPersonality, PresenterStyle } from '../types/clip.js';
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
import {
  ensureGreenScreenBackground,
  greenScreenDerivativePath,
} from '../services/image.service.js';

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
// Shared scene prompt fragments
// ---------------------------------------------------------------------------

// Uniform talking-head prompt used for every presenter-mode segment.
// Leads with the green screen and repeats the identical voice description in
// every segment — each 8s clip is a separate Veo generation, so the prompt is
// the only thing keeping voice, framing, and background consistent across cuts.
// Now personality-aware: body language, energy, and delivery vary by mood.
function getPresenterScenePrompt(personality: PresenterPersonality = 'social'): string {
  const personalityVisuals: Record<string, string> = {
    social:
      'A person casually talking directly to camera like they are recording a social media video, framed from the chest up, centered in the frame. ' +
      'Relaxed, expressive, and animated — like filming a TikTok or Instagram Reel. Natural casual lighting on the person. ' +
      'The person speaks in the exact same voice in every clip: a warm, clear, medium-pitched adult voice, natural conversational tone, steady volume, even pace.',
    calm:
      'A person speaking gently and directly to camera, framed from the chest up, centered in the frame. ' +
      'Completely relaxed posture, minimal hand gestures, serene expression. Soft, even natural lighting. ' +
      'The person speaks in the exact same voice in every clip: a soft, soothing, low-to-medium-pitched adult voice, slow and measured pace, calm and steady volume.',
    pensive:
      'A person speaking thoughtfully to camera, framed from the chest up, centered in the frame. ' +
      'Slightly tilted head, occasionally looking slightly off-camera as if considering an idea, then returning to direct eye contact. Muted, contemplative natural lighting. ' +
      'The person speaks in the exact same voice in every clip: a quiet, reflective, medium-pitched adult voice, deliberate pacing with thoughtful pauses, gentle volume.',
    happy:
      'A person speaking brightly to camera with a genuine warm smile, framed from the chest up, centered in the frame. ' +
      'Open posture, natural smiling, eyes lit up with delight. Bright, warm natural lighting. ' +
      'The person speaks in the exact same voice in every clip: a cheerful, bright, medium-to-high-pitched adult voice, upbeat natural pace, warm and pleasant volume.',
    energetic:
      'A person speaking with high energy directly to camera, framed from the chest up, centered in the frame. ' +
      'Animated hand gestures, wide eyes, leaning slightly forward with excitement. Bright, dynamic lighting. ' +
      'The person speaks in the exact same voice in every clip: a strong, energetic, clear adult voice, fast-paced and enthusiastic delivery, confident volume.',
    serious:
      'A person speaking with authority directly to camera, framed from the chest up, centered in the frame. ' +
      'Composed, upright posture, minimal but purposeful hand gestures. Professional, even studio-style lighting. ' +
      'The person speaks in the exact same voice in every clip: a deep, authoritative, resonant adult voice, measured and deliberate pace, steady commanding volume.',
    witty:
      'A person speaking with a subtle knowing expression to camera, framed from the chest up, centered in the frame. ' +
      'Occasional raised eyebrow, slight smirk, relaxed but sharp body language. Warm, slightly stylized natural lighting. ' +
      'The person speaks in the exact same voice in every clip: a clever, articulate, medium-pitched adult voice, well-timed pacing with comedic beats, conversational volume.',
    warm:
      'A person speaking kindly and directly to camera, framed from the chest up, centered in the frame. ' +
      'Open, welcoming posture, gentle nodding, soft genuine expressions. Warm golden-toned natural lighting. ' +
      'The person speaks in the exact same voice in every clip: a gentle, friendly, medium-pitched adult voice, unhurried natural pace, soft and inviting volume.',
    intense:
      'A person speaking with focused passion directly to camera, framed from the chest up, centered in the frame. ' +
      'Leaning slightly forward, purposeful hand gestures for emphasis, unwavering eye contact. Dramatic, focused lighting with slight contrast. ' +
      'The person speaks in the exact same voice in every clip: a powerful, resonant, medium-to-low-pitched adult voice, varied pacing that builds intensity, strong and compelling volume.',
  };

  const visual = personalityVisuals[personality] || personalityVisuals.social;

  return (
    'The entire background is a solid, uniform, bright green chroma key screen (#00FF00). ' +
    'A flat green screen fills every part of the frame behind the person — no room, no wall texture, no scenery, no furniture, no environment of any kind. ' +
    visual + ' Same person, same voice, same energy, same framing throughout. ' +
    'One single continuous take from a static locked-off camera: no transitions, no cuts, no fades, no wipes, no cross-dissolves, no jump cuts, no scene changes, no camera movement, no zoom. ' +
    'There is absolutely NO music of any kind: no background music, no soundtrack, no musical score, no instrumental music, no ambient music, no melody, no humming, no singing. ' +
    'No background noise, no sound effects, no audio transitions, no whooshes. The only sound in the entire clip is the person\'s clean spoken voice. ' +
    'The person starts speaking immediately when the clip begins, speaks at a natural pace, and finishes saying the entire text completely just before the clip ends — the speech must never be cut off mid-word or mid-sentence.'
  );
}

// Wrapped around EVERY story-mode scene prompt: green screen background first
// (Veo weights the start of the prompt most heavily), reinforced at the end.
const SCENE_STYLE_PREFIX =
  'The entire background is a solid, uniform, bright green chroma key screen (#00FF00) — ' +
  'a flat green screen fills the frame behind the subject, with no scenery or environment of any kind. ' +
  'One single continuous shot with no transitions, no cuts, no fades, and no scene changes. ';
const SCENE_STYLE_SUFFIX =
  ' The entire background MUST be a solid, uniform bright green chroma key screen (#00FF00). ' +
  'No other background elements, scenery, or environments — only a flat green screen behind the subject. ' +
  'One single continuous shot: absolutely no transitions, no cuts, no fades, no wipes, no cross-dissolves, no scene changes.';

// Sent to Veo as negativePrompt alongside every segment. Veo negative prompts
// list unwanted concepts directly (no "no ..." phrasing).
const NEGATIVE_PROMPT =
  'scene transitions, cuts, fades, cross-dissolves, wipes, jump cuts, scene changes, montage, split screen, ' +
  'background scenery, room interior, outdoor landscape, sky, buildings, trees, furniture, walls, windows, ' +
  'on-screen text, captions, subtitles, watermark, logo, ' +
  'music, background music, soundtrack, musical score, instrumental music, ambient music, melody, jingle, humming, singing, ' +
  'background noise, sound effects, whoosh sounds, audio transitions';

// Deliberately safe fallback prompt for presenter mode.
const PRESENTER_FALLBACK_SCENE =
  'A static locked-off shot of a blank bright green chroma key screen background (#00FF00). ' +
  'No movement, no people, no objects, no transitions. ' +
  'Absolute complete silence. No sound, no background noise, no ambient audio, no voice, no music, no sound effects.';

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

// List all completed videos with filesystem metadata
apiRouter.get('/videos', async (_req: Request, res: Response) => {
  const clips = getAllClips().filter(
    (c) => c.status === 'complete' && (c.finalPath || c.videoPath),
  );

  const results = await Promise.all(
    clips.map(async (c) => {
      const filePath = (c.finalPath || c.videoPath)!;
      const filename = path.basename(filePath);
      let sizeBytes = 0;
      try {
        const stat = await fs.stat(filePath);
        sizeBytes = stat.size;
      } catch {
        // file may have been deleted — skip size
      }
      return {
        id: c.id,
        title: c.title || 'Untitled',
        mode: c.mode || 'story',
        createdAt: c.createdAt,
        caption: c.caption,
        url: `/media/${filename}`,
        filename,
        sizeBytes,
        length: c.length,
      };
    }),
  );

  // Newest first
  results.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  res.json(results);
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

      const { storyText, speakerVoice, length, ensureContinuity, characterProfile, enableMusic, enableNarration, mode, presenterPersonality, presenterStyle } = req.body;

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
        title: storyText.trim().slice(0, 60).split('\n')[0].trim() || 'Untitled',
        storyText,
        referenceImagePaths: imagePaths,
        speakerVoice: speakerVoice || getDefaultVoice(),
        characterProfile: characterProfile?.trim() || undefined,
        // Presenter mode must never have background music, regardless of what the client sends
        enableMusic: mode === 'presenter' ? false : enableMusic === 'true' || enableMusic === true,
        enableNarration: enableNarration !== 'false' && enableNarration !== false,
        length: parsedLength,
        ensureContinuity: ensureContinuity === 'true' || ensureContinuity === true,
        mode: mode === 'presenter' ? 'presenter' : 'story',
        presenterPersonality: (mode === 'presenter' && presenterPersonality) ? presenterPersonality as PresenterPersonality : undefined,
        presenterStyle: (mode === 'presenter' && presenterStyle) ? presenterStyle as PresenterStyle : undefined,
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
      // Presenter mode: generate narration pre-split into per-segment parts,
      // use uniform talking-head prompt
      const presenterResult = await generatePresenterScript({
        storyText: clip.storyText,
        targetSeconds: clip.length,
        segmentCount,
        personality: clip.presenterPersonality,
        style: clip.presenterStyle,
      });

      const scenePrompt = getPresenterScenePrompt(clip.presenterPersonality);
      updateClip(clip.id, {
        narrationScript: presenterResult.narrationScript,
        narrationSegments: presenterResult.segments,
        scenePrompts: Array.from({ length: segmentCount }, () => scenePrompt),
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
  if (musicPromptOverride && typeof musicPromptOverride === 'string' && clip.mode !== 'presenter') {
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

  // Clean up files (including cached green-screened derivatives)
  const filePaths = [
    ...clip.referenceImagePaths,
    ...clip.referenceImagePaths.map(greenScreenDerivativePath),
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

/**
 * Split narration into up to segmentCount chunks on sentence boundaries with
 * roughly equal word counts. Splitting mid-sentence makes Veo cut words off
 * at the 8-second segment boundary, which is audible after stitching.
 */
function splitNarrationBySentence(narration: string, segmentCount: number): string[] {
  const sentences =
    narration
      .match(/[^.!?…]+[.!?…]+["')\]]*|[^.!?…]+$/g)
      ?.map((s) => s.trim())
      .filter(Boolean) ?? [];
  if (sentences.length === 0) return [narration.trim()].filter(Boolean);

  const totalWords = narration.split(/\s+/).filter(Boolean).length;
  const targetPerSegment = totalWords / segmentCount;

  const chunks: string[] = [];
  let current: string[] = [];
  let currentWords = 0;

  for (const sentence of sentences) {
    current.push(sentence);
    currentWords += sentence.split(/\s+/).length;
    if (chunks.length < segmentCount - 1 && currentWords >= targetPerSegment) {
      chunks.push(current.join(' '));
      current = [];
      currentWords = 0;
    }
  }
  if (current.length > 0) chunks.push(current.join(' '));
  return chunks;
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
    } else if (clip.mode === 'presenter') {
      updateClip(clipId, { status: 'preparing_script', totalSegments: segmentCount });

      const presenterResult = await generatePresenterScript({
        storyText: clip.storyText,
        targetSeconds: clip.length,
        segmentCount,
        personality: clip.presenterPersonality,
        style: clip.presenterStyle,
      });
      const pipelineScenePrompt = getPresenterScenePrompt(clip.presenterPersonality);
      story = {
        narrationScript: presenterResult.narrationScript,
        scenes: Array.from({ length: segmentCount }, () => ({ prompt: pipelineScenePrompt })),
        caption: presenterResult.caption,
      };

      updateClip(clipId, {
        narrationScript: presenterResult.narrationScript,
        narrationSegments: presenterResult.segments,
        scenePrompts: story.scenes.map((s) => s.prompt),
        caption: presenterResult.caption || undefined,
        status: 'generating_video',
      });
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

    // ── Step 1.5: Green-screen the reference images ──────────────────
    // Veo image-to-video keeps the seed image's background, so the seeds
    // themselves must have a green background — prompts alone can't force it.
    let seedImagePaths = clip.referenceImagePaths;
    if (seedImagePaths.length > 0) {
      console.log(`[pipeline] Green-screening ${seedImagePaths.length} reference image(s)`);
      seedImagePaths = await Promise.all(
        seedImagePaths.map((p) => ensureGreenScreenBackground(p)),
      );
    }

    // ── Step 2: Generate Veo segments (Sequential vs Parallel) ──────
    const seedAssignments = assignSeedImages(seedImagePaths, segmentCount);

    // For presenter mode, use the single face image for ALL segments
    // and embed narration text into each scene prompt
    if (clip.mode === 'presenter' && seedImagePaths.length > 0) {
      seedAssignments.clear();
      const faceImage = seedImagePaths[0];
      for (let i = 0; i < segmentCount; i++) {
        seedAssignments.set(i, faceImage);
      }
    }

    if (clip.mode === 'presenter') {
      // Prefer the per-segment parts Gemini authored (sized to fill 8s each
      // without overrunning). If the user edited the script afterwards, the
      // stored parts are stale — fall back to sentence-boundary splitting so
      // no segment starts or ends mid-sentence.
      const norm = (s: string) => s.replace(/\s+/g, ' ').trim();
      const storedSegments = getClip(clipId)?.narrationSegments;
      const segmentTexts =
        storedSegments &&
        storedSegments.length > 0 &&
        norm(storedSegments.join(' ')) === norm(story.narrationScript)
          ? storedSegments
          : splitNarrationBySentence(story.narrationScript, segmentCount);

      for (let i = 0; i < Math.min(story.scenes.length, segmentCount); i++) {
        // If we have text for this segment, use it; otherwise repeat the last chunk
        const segText = segmentTexts[i] || segmentTexts[segmentTexts.length - 1] || story.narrationScript;
        story.scenes[i] = {
          prompt:
            getPresenterScenePrompt(clip.presenterPersonality) +
            ` The person says out loud: "${segText}"` +
            ' This spoken voice is the ONLY audio — no background music or soundtrack anywhere in the clip.',
        };
      }
      console.log(
        `[pipeline] Presenter mode: embedded narration into ${segmentCount} segment(s) ` +
          `(${segmentTexts === storedSegments ? 'Gemini-authored parts' : 'sentence-split fallback'}, ` +
          `${segmentTexts.map((t) => t.split(/\s+/).length).join('/')} words)`,
      );
    } else {
      // Story mode: wrap every scene so it's a single continuous green-screen
      // shot (presenter prompts already contain this)
      for (let i = 0; i < story.scenes.length; i++) {
        story.scenes[i].prompt = SCENE_STYLE_PREFIX + story.scenes[i].prompt + SCENE_STYLE_SUFFIX;
      }
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
            negativePrompt: NEGATIVE_PROMPT,
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
            prompt: clip.mode === 'presenter' ? PRESENTER_FALLBACK_SCENE : SAFE_FALLBACK_SCENE + SCENE_STYLE_SUFFIX,
            negativePrompt: NEGATIVE_PROMPT,
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
              negativePrompt: NEGATIVE_PROMPT,
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
              prompt: clip.mode === 'presenter' ? PRESENTER_FALLBACK_SCENE : SAFE_FALLBACK_SCENE + SCENE_STYLE_SUFFIX,
              negativePrompt: NEGATIVE_PROMPT,
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
