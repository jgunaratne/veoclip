import { Router, Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs/promises';
import { v4 as uuidv4 } from 'uuid';
import sharp from 'sharp';
import type { Clip, StoryLength, PresenterPersonality, PresenterStyle, VoiceAge, VoicePitch, VoiceTexture, VoiceAccent } from '../types/clip.js';
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
  crossfadeVideos,
  isolateSpeech,
  chromaKeyComposite,
  extractLastFrame,
} from '../services/mux.service.js';
import { generateBackgroundMusic } from '../services/music.service.js';
import { separateVocals } from '../services/vocal.service.js';
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

// Separate multer instance for background-video uploads (composite feature).
const videoUpload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500 MB per video
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('video/')) {
      cb(null, true);
    } else {
      cb(new Error('Only video files are accepted'));
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

// Per-personality prompt fragments. The voice is split into composable parts
// (tone / pitch / delivery) so user voice options can override individual
// pieces without losing the personality's character.
const PERSONALITY_STYLES: Record<
  string,
  { visual: string; tone: string; pitch: string; delivery: string }
> = {
  social: {
    visual:
      'A person casually talking directly to camera like they are recording a social media video, framed from the chest up, centered in the frame. ' +
      'Relaxed, expressive, and animated — filming a solo video alone in a completely quiet room. Natural casual lighting on the person.',
    tone: 'warm, clear',
    pitch: 'medium-pitched',
    delivery: 'natural conversational tone, steady volume, even pace',
  },
  calm: {
    visual:
      'A person speaking gently and directly to camera, framed from the chest up, centered in the frame. ' +
      'Completely relaxed posture, minimal hand gestures, serene expression. Soft, even natural lighting.',
    tone: 'soft, soothing',
    pitch: 'low-to-medium-pitched',
    delivery: 'slow and measured pace, calm and steady volume',
  },
  pensive: {
    visual:
      'A person speaking thoughtfully to camera, framed from the chest up, centered in the frame. ' +
      'Slightly tilted head, occasionally looking slightly off-camera as if considering an idea, then returning to direct eye contact. Muted, contemplative natural lighting.',
    tone: 'quiet, reflective',
    pitch: 'medium-pitched',
    delivery: 'deliberate pacing with thoughtful pauses, gentle volume',
  },
  happy: {
    visual:
      'A person speaking brightly to camera with a genuine warm smile, framed from the chest up, centered in the frame. ' +
      'Open posture, natural smiling, eyes lit up with delight. Bright, warm natural lighting.',
    tone: 'cheerful, bright',
    pitch: 'medium-to-high-pitched',
    delivery: 'upbeat natural pace, warm and pleasant volume',
  },
  energetic: {
    visual:
      'A person speaking with high energy directly to camera, framed from the chest up, centered in the frame. ' +
      'Animated hand gestures, wide eyes, leaning slightly forward with excitement. Bright, dynamic lighting.',
    tone: 'strong, energetic, clear',
    pitch: 'medium-pitched',
    delivery: 'fast-paced and enthusiastic delivery, confident volume',
  },
  serious: {
    visual:
      'A person speaking with authority directly to camera, framed from the chest up, centered in the frame. ' +
      'Composed, upright posture, minimal but purposeful hand gestures. Professional, even studio-style lighting.',
    tone: 'authoritative, resonant',
    pitch: 'deep, low-pitched',
    delivery: 'measured and deliberate pace, steady commanding volume',
  },
  witty: {
    visual:
      'A person speaking with a subtle knowing expression to camera, framed from the chest up, centered in the frame. ' +
      'Occasional raised eyebrow, slight smirk, relaxed but sharp body language. Warm, slightly stylized natural lighting.',
    tone: 'clever, articulate',
    pitch: 'medium-pitched',
    delivery: 'well-timed pacing with comedic beats, conversational volume',
  },
  warm: {
    visual:
      'A person speaking kindly and directly to camera, framed from the chest up, centered in the frame. ' +
      'Open, welcoming posture, gentle nodding, soft genuine expressions. Warm golden-toned natural lighting.',
    tone: 'gentle, friendly',
    pitch: 'medium-pitched',
    delivery: 'unhurried natural pace, soft and inviting volume',
  },
  intense: {
    visual:
      'A person speaking with focused passion directly to camera, framed from the chest up, centered in the frame. ' +
      'Leaning slightly forward, purposeful hand gestures for emphasis, unwavering eye contact. Dramatic, focused lighting with slight contrast.',
    tone: 'powerful, resonant',
    pitch: 'medium-to-low-pitched',
    delivery: 'varied pacing that builds intensity, strong and compelling volume',
  },
};

// User voice-option phrases layered onto the personality defaults.
const VOICE_PITCH_PHRASES: Record<Exclude<VoicePitch, 'default'>, string> = {
  very_low: 'very deep, low-pitched',
  low: 'low-pitched',
  high: 'slightly high-pitched',
  very_high: 'high-pitched',
};

const VOICE_TEXTURE_PHRASES: Record<Exclude<VoiceTexture, 'default'>, string> = {
  raspy: 'with a distinctive gravelly rasp',
  breathy: 'with a soft, breathy quality',
  husky: 'with a smoky, husky edge',
  bright: 'with a crisp, bright, polished quality',
};

const VOICE_AGE_PHRASES: Record<Exclude<VoiceAge, 'default'>, string> = {
  gen_z:
    'delivered with the contemporary intonation of a Gen Z twenty-something — relaxed modern inflection, occasional subtle vocal fry, casual rising emphasis',
  millennial:
    'delivered with the friendly, expressive cadence of a millennial in their early thirties — conversational and effortlessly casual',
  gen_x:
    'delivered with the grounded, unhurried cadence of a Gen X adult in their late forties',
  mature:
    'delivered with the measured, seasoned cadence of an older adult in their sixties',
};

// Accents are deliberately phrased as subtle — a light coloring of the
// speech, never a caricature.
const VOICE_ACCENT_PHRASES: Record<Exclude<VoiceAccent, 'default'>, string> = {
  american: 'speaking with a mild, neutral American accent',
  british: 'speaking with a soft, understated British English accent',
  german:
    'speaking fluent English with a subtle, light German accent — a gentle coloring of the pronunciation, never strong or exaggerated',
  french:
    'speaking fluent English with a subtle, light French accent — a gentle coloring of the pronunciation, never strong or exaggerated',
  spanish:
    'speaking fluent English with a subtle, light Spanish accent — a gentle coloring of the pronunciation, never strong or exaggerated',
};

export interface PresenterVoiceOptions {
  age?: VoiceAge;
  pitch?: VoicePitch;
  texture?: VoiceTexture;
  accent?: VoiceAccent;
}

// Uniform talking-head prompt used for every presenter-mode segment.
// Leads with the green screen and repeats the identical voice description in
// every segment — each 8s clip is a separate Veo generation, so the prompt is
// the only thing keeping voice, framing, and background consistent across cuts.
// Personality sets body language and the default voice; user voice options
// (pitch / texture / generational cadence) override or extend it.
export function getPresenterScenePrompt(
  personality: PresenterPersonality = 'social',
  voice: PresenterVoiceOptions = {},
): string {
  const style = PERSONALITY_STYLES[personality] || PERSONALITY_STYLES.social;

  const pitch =
    voice.pitch && voice.pitch !== 'default' ? VOICE_PITCH_PHRASES[voice.pitch] : style.pitch;
  const texture =
    voice.texture && voice.texture !== 'default'
      ? ` ${VOICE_TEXTURE_PHRASES[voice.texture]}`
      : '';
  const age =
    voice.age && voice.age !== 'default' ? `, ${VOICE_AGE_PHRASES[voice.age]}` : '';
  const accent =
    voice.accent && voice.accent !== 'default'
      ? `, ${VOICE_ACCENT_PHRASES[voice.accent]}`
      : '';

  const article = /^[aeiou]/i.test(style.tone) ? 'an' : 'a';
  const voiceSentence =
    `The person speaks in the exact same voice and the exact same accent in every clip: ` +
    `${article} ${style.tone}, ${pitch} adult voice${texture}, ${style.delivery}${accent}${age}. ` +
    `The voice and accent are perfectly identical and consistent from clip to clip — never shifting in accent, pitch, or character.`;

  return (
    'The entire background is a solid, uniform, bright green chroma key screen (#00FF00). ' +
    'A flat green screen fills every part of the frame behind the person — no room, no wall texture, no scenery, no furniture, no environment of any kind. ' +
    style.visual + ' ' + voiceSentence + ' Same person, same voice, same accent, same energy, same framing throughout. ' +
    'One single continuous take from a static locked-off camera: no transitions, no cuts, no fades, no wipes, no cross-dissolves, no jump cuts, no scene changes, no camera movement, no zoom. ' +
    'The person is completely alone in a silent, soundproofed studio — no one else is present: no audience, no crowd, no bystanders, no one off-camera. ' +
    'There is absolutely NO music of any kind: no background music, no soundtrack, no musical score, no instrumental music, no ambient music, no melody, no humming, no singing. ' +
    'No laughter, no giggling, no audience reactions, no applause, no other voices. ' +
    'No background noise, no sound effects, no audio transitions, no whooshes. The only sound in the entire clip is the person\'s clean spoken voice. ' +
    'The person starts speaking immediately when the clip begins, speaks at a natural pace, and finishes saying the entire text completely just before the clip ends — the speech must never be cut off mid-word or mid-sentence.'
  );
}

// Voice options as stored on a clip, in the shape getPresenterScenePrompt takes.
function clipVoiceOptions(clip: Clip): PresenterVoiceOptions {
  return { age: clip.voiceAge, pitch: clip.voicePitch, texture: clip.voiceTexture, accent: clip.voiceAccent };
}

// Validate a client-supplied voice option against the known phrase map.
// Returns undefined for 'default', unknown values, or missing input.
function parseVoiceOption<T extends string>(
  value: unknown,
  phrases: Partial<Record<T, string>>,
): T | undefined {
  return typeof value === 'string' && value in phrases ? (value as T) : undefined;
}

// Wrapped around EVERY story-mode scene prompt: enforces one continuous take
// per segment (Veo weights the prompt edges most heavily). Story scenes keep
// their full environments — no green screen in story mode.
const SCENE_STYLE_PREFIX =
  'One single continuous cinematic shot with no transitions, no cuts, no fades, and no scene changes. ';
const SCENE_STYLE_SUFFIX =
  ' One single continuous shot: absolutely no transitions, no cuts, no fades, no wipes, no cross-dissolves, no scene changes.';

// Sent to Veo as negativePrompt alongside every segment. Veo negative prompts
// list unwanted concepts directly (no "no ..." phrasing).
const TRANSITION_TERMS =
  'scene transitions, cuts, fades, cross-dissolves, wipes, jump cuts, scene changes, montage, split screen';
const TEXT_TERMS = 'on-screen text, captions, subtitles, watermark, logo';
const MUSIC_TERMS =
  'music, background music, soundtrack, musical score, instrumental music, ambient music, melody, jingle, humming, singing';

// Story mode: scenery and sound effects are welcome — scenes are full cinematic
// environments. Only Veo-generated music is suppressed, because the Lyria track
// is mixed in after generation and the two would clash.
const NEGATIVE_PROMPT = [TRANSITION_TERMS, TEXT_TERMS, MUSIC_TERMS].join(', ');

// Presenter mode: strict talking-head — no environment, and no audio of any
// kind except the presenter's voice.
const PRESENTER_NEGATIVE_PROMPT = [
  TRANSITION_TERMS,
  'background scenery, room interior, outdoor landscape, sky, buildings, trees, furniture, walls, windows',
  TEXT_TERMS,
  MUSIC_TERMS,
  'background noise, sound effects, whoosh sounds, audio transitions',
  'laughter, laughing, giggling, chuckling, laugh track, audience, audience reactions, applause, clapping, ' +
    'cheering, crowd noise, background voices, off-screen voices, chatter, multiple people talking, echo',
].join(', ');

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

// List unique face photos used in previous presenter clips.
// Returns an array of { url, clipTitle, createdAt } objects, newest first.
apiRouter.get('/presenter-photos', async (_req: Request, res: Response) => {
  try {
    const clips = getAllClips().filter(
      (c) => c.mode === 'presenter' && c.referenceImagePaths.length > 0,
    );

    // Deduplicate by basename — the same photo uploaded twice gets the same name
    const seen = new Set<string>();
    const photos: { url: string; path: string; clipTitle: string; createdAt: string }[] = [];

    // Newest clips first so we keep the most recent occurrence
    clips.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

    for (const clip of clips) {
      for (const imgPath of clip.referenceImagePaths) {
        const basename = path.basename(imgPath);
        if (seen.has(basename)) continue;
        seen.add(basename);
        // Verify the file still exists on disk
        try {
          await fs.access(imgPath);
          photos.push({
            url: `/uploads/${basename}`,
            path: imgPath,
            clipTitle: clip.title || 'Untitled',
            createdAt: clip.createdAt,
          });
        } catch {
          // File was deleted — skip
        }
      }
    }

    res.json(photos);
  } catch (err) {
    console.error('[api] Presenter photos failed:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// List all uploaded image files with metadata and clip usage.
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.avif', '.heic', '.heif', '.tiff', '.tif', '.bmp']);

apiRouter.get('/images', async (_req: Request, res: Response) => {
  try {
    const dirPath = path.resolve(uploadDir);
    const entries = await fs.readdir(dirPath);
    const allClips = getAllClips();

    // Build a map of image path → clip titles that reference it
    const usageMap = new Map<string, string[]>();
    for (const clip of allClips) {
      for (const imgPath of clip.referenceImagePaths) {
        const basename = path.basename(imgPath);
        const existing = usageMap.get(basename) || [];
        existing.push(clip.title || 'Untitled');
        usageMap.set(basename, existing);
      }
    }

    const images = await Promise.all(
      entries
        .filter((name) => IMAGE_EXTENSIONS.has(path.extname(name).toLowerCase()))
        .map(async (name) => {
          const filePath = path.join(dirPath, name);
          const stat = await fs.stat(filePath);
          return {
            filename: name,
            url: `/uploads/${name}`,
            sizeBytes: stat.size,
            createdAt: stat.birthtime.toISOString(),
            usedBy: usageMap.get(name) || [],
          };
        }),
    );

    // Newest first
    images.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    res.json(images);
  } catch (err) {
    console.error('[api] Image listing failed:', err);
    res.status(500).json({ error: (err as Error).message });
  }
});

// Upload new image assets (reuses the existing multer config)
apiRouter.post(
  '/images',
  upload.array('images', MAX_IMAGES),
  async (req: Request, res: Response) => {
    try {
      const files = (req.files as Express.Multer.File[] | undefined) ?? [];
      if (files.length === 0) {
        res.status(400).json({ error: 'No image files provided' });
        return;
      }

      const imagePaths = await Promise.all(files.map((f) => ensureJpeg(f.path)));
      const results = await Promise.all(
        imagePaths.map(async (p) => {
          const stat = await fs.stat(p);
          const name = path.basename(p);
          return {
            filename: name,
            url: `/uploads/${name}`,
            sizeBytes: stat.size,
            createdAt: stat.birthtime.toISOString(),
            usedBy: [] as string[],
          };
        }),
      );

      res.status(201).json(results);
    } catch (err) {
      console.error('[api] Image upload failed:', err);
      res.status(500).json({ error: (err as Error).message });
    }
  },
);

// Delete an uploaded image file
apiRouter.delete('/images/:filename', async (req: Request, res: Response) => {
  const { filename } = req.params;
  // Security: prevent path traversal
  if (filename.includes('/') || filename.includes('\\') || filename === '..') {
    res.status(400).json({ error: 'Invalid filename' });
    return;
  }

  const filePath = path.join(path.resolve(uploadDir), filename);
  try {
    await fs.access(filePath);
    await fs.unlink(filePath);
    res.status(204).send();
  } catch {
    res.status(404).json({ error: 'File not found' });
  }
});

// Composite: superimpose a green-screen presenter video onto a background
// video. The background comes either from an uploaded file ('background')
// or an existing clip (backgroundClipId). Returns a clip in mode 'composite'
// that can be tracked like any other clip and shows up in /videos when done.
apiRouter.post(
  '/composite',
  videoUpload.single('background'),
  async (req: Request, res: Response) => {
    try {
      const { presenterClipId, backgroundClipId, presenterScale: scaleRaw } = req.body;

      // Clamp presenter scale to a sensible range (10%–100% of frame height)
      const presenterScale = scaleRaw
        ? Math.max(0.1, Math.min(1.0, parseFloat(scaleRaw)))
        : undefined;

      const presenter = getClip(presenterClipId);
      const presenterPath = presenter?.finalPath || presenter?.videoPath;
      if (!presenter || presenter.mode !== 'presenter' || presenter.status !== 'complete' || !presenterPath) {
        res.status(400).json({ error: 'presenterClipId must reference a completed presenter-mode clip' });
        return;
      }

      let backgroundPath = req.file?.path;
      if (!backgroundPath && backgroundClipId) {
        const bg = getClip(backgroundClipId);
        backgroundPath = bg?.finalPath || bg?.videoPath;
      }
      if (!backgroundPath) {
        res.status(400).json({ error: 'Provide a background video upload or a backgroundClipId' });
        return;
      }

      const clip: Clip = {
        id: uuidv4(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        title: `Composite — ${presenter.title || 'Presenter'}`,
        storyText: presenter.storyText,
        referenceImagePaths: [],
        speakerVoice: presenter.speakerVoice,
        length: presenter.length,
        mode: 'composite',
        status: 'muxing',
      };
      setClip(clip);
      res.status(202).json(clip);

      // Run the composite async — the client tracks it via /clips/:id
      (async () => {
        try {
          const finalPath = await chromaKeyComposite({
            presenterPath,
            backgroundPath: backgroundPath!,
            outputDir,
            clipId: clip.id,
            presenterScale,
          });
          updateClip(clip.id, { finalPath, status: 'complete' });
          console.log(`[composite] Clip ${clip.id} complete!`);
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          console.error(`[composite] Failed for clip ${clip.id}:`, message);
          updateClip(clip.id, { status: 'error', error: message });
        }
      })();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error('[api] Composite request failed:', message);
      res.status(500).json({ error: message });
    }
  },
);

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

      const { storyText, speakerVoice, length, ensureContinuity, characterProfile, enableMusic, enableNarration, mode, presenterPersonality, presenterStyle, crossfade, voiceAge, voicePitch, voiceTexture, voiceAccent, existingImagePath } = req.body;

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
      let imagePaths = await Promise.all(
        files.map((f) => ensureJpeg(f.path)),
      );

      // Allow reusing a previously uploaded image when no new files are provided
      if (imagePaths.length === 0 && existingImagePath && typeof existingImagePath === 'string') {
        const resolved = path.resolve(existingImagePath);
        // Security: only allow paths within the uploads directory
        if (resolved.startsWith(path.resolve(uploadDir))) {
          try {
            await fs.access(resolved);
            imagePaths = [resolved];
          } catch {
            // File doesn't exist — ignore silently
          }
        }
      }

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
        crossfade: crossfade === 'true' || crossfade === true,
        mode: mode === 'presenter' ? 'presenter' : 'story',
        presenterPersonality: (mode === 'presenter' && presenterPersonality) ? presenterPersonality as PresenterPersonality : undefined,
        presenterStyle: (mode === 'presenter' && presenterStyle) ? presenterStyle as PresenterStyle : undefined,
        voiceAge: mode === 'presenter' ? parseVoiceOption<VoiceAge>(voiceAge, VOICE_AGE_PHRASES) : undefined,
        voicePitch: mode === 'presenter' ? parseVoiceOption<VoicePitch>(voicePitch, VOICE_PITCH_PHRASES) : undefined,
        voiceTexture: mode === 'presenter' ? parseVoiceOption<VoiceTexture>(voiceTexture, VOICE_TEXTURE_PHRASES) : undefined,
        voiceAccent: mode === 'presenter' ? parseVoiceOption<VoiceAccent>(voiceAccent, VOICE_ACCENT_PHRASES) : undefined,
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

      const scenePrompt = getPresenterScenePrompt(clip.presenterPersonality, clipVoiceOptions(clip));
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

  // If the user sent an edited narrationScript, musicPrompt, or crossfade
  // setting, store them before launching. The crossfade checkbox can be
  // toggled after the clip was created, so the generate-time value wins.
  const { narrationScript: narrationOverride, musicPrompt: musicPromptOverride, crossfade: crossfadeOverride, ensureContinuity: continuityOverride, voiceAge: voiceAgeOverride, voicePitch: voicePitchOverride, voiceTexture: voiceTextureOverride, voiceAccent: voiceAccentOverride } = req.body ?? {};
  if (narrationOverride && typeof narrationOverride === 'string') {
    updateClip(clip.id, { narrationScript: narrationOverride });
  }
  if (musicPromptOverride && typeof musicPromptOverride === 'string' && clip.mode !== 'presenter') {
    updateClip(clip.id, { musicPrompt: musicPromptOverride });
  }
  if (typeof crossfadeOverride === 'boolean') {
    updateClip(clip.id, { crossfade: crossfadeOverride });
  }
  if (typeof continuityOverride === 'boolean') {
    updateClip(clip.id, { ensureContinuity: continuityOverride });
  }
  if (clip.mode === 'presenter' && (voiceAgeOverride || voicePitchOverride || voiceTextureOverride || voiceAccentOverride)) {
    updateClip(clip.id, {
      voiceAge: parseVoiceOption<VoiceAge>(voiceAgeOverride, VOICE_AGE_PHRASES),
      voicePitch: parseVoiceOption<VoicePitch>(voicePitchOverride, VOICE_PITCH_PHRASES),
      voiceTexture: parseVoiceOption<VoiceTexture>(voiceTextureOverride, VOICE_TEXTURE_PHRASES),
      voiceAccent: parseVoiceOption<VoiceAccent>(voiceAccentOverride, VOICE_ACCENT_PHRASES),
    });
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
      const pipelineScenePrompt = getPresenterScenePrompt(clip.presenterPersonality, clipVoiceOptions(clip));
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

    // ── Step 1.5: Green-screen the reference images (presenter only) ──
    // Presenter mode needs a chroma-key background, and Veo image-to-video
    // keeps the seed image's background — so presenter seeds must be
    // green-screened. Story mode uses the photos untouched: their settings,
    // backgrounds, and every original element carry into the video.
    let seedImagePaths = clip.referenceImagePaths;
    if (clip.mode === 'presenter' && seedImagePaths.length > 0) {
      console.log(`[pipeline] Green-screening ${seedImagePaths.length} reference image(s)`);
      seedImagePaths = await Promise.all(
        seedImagePaths.map((p) => ensureGreenScreenBackground(p)),
      );
    }

    // ── Step 2: Generate Veo segments (Sequential vs Parallel) ──────
    const seedAssignments = assignSeedImages(seedImagePaths, segmentCount);

    // For presenter mode, seed segments with the single face image and embed
    // narration text into each scene prompt. With continuity enabled the face
    // only seeds the first segment — later segments continue from the previous
    // segment's last frame, so motion flows across cuts. Without it, every
    // segment restarts from the face photo (most faithful likeness, harder cuts).
    if (clip.mode === 'presenter' && seedImagePaths.length > 0) {
      seedAssignments.clear();
      const faceImage = seedImagePaths[0];
      if (clip.ensureContinuity) {
        seedAssignments.set(0, faceImage);
      } else {
        for (let i = 0; i < segmentCount; i++) {
          seedAssignments.set(i, faceImage);
        }
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
            getPresenterScenePrompt(clip.presenterPersonality, clipVoiceOptions(clip)) +
            ` The person says out loud: "${segText}"` +
            ' This spoken voice is the ONLY audio — no background music, no laughter, no other voices, no sounds of any kind anywhere in the clip.',
        };
      }
      console.log(
        `[pipeline] Presenter mode: embedded narration into ${segmentCount} segment(s) ` +
          `(${segmentTexts === storedSegments ? 'Gemini-authored parts' : 'sentence-split fallback'}, ` +
          `${segmentTexts.map((t) => t.split(/\s+/).length).join('/')} words)`,
      );
    } else {
      // Story mode: wrap every scene so it's a single continuous shot with no
      // transitions (presenter prompts already contain this)
      for (let i = 0; i < story.scenes.length; i++) {
        story.scenes[i].prompt = SCENE_STYLE_PREFIX + story.scenes[i].prompt + SCENE_STYLE_SUFFIX;
      }
    }

    const segmentPaths: string[] = [];
    const useContinuity = clip.ensureContinuity || clip.mode === 'presenter';
    const negativePrompt = clip.mode === 'presenter' ? PRESENTER_NEGATIVE_PROMPT : NEGATIVE_PROMPT;

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
            negativePrompt,
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
            negativePrompt,
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
              negativePrompt,
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
              negativePrompt,
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

    // Join segments if we have more than one — crossfade or hard cuts
    let videoPath: string;
    if (segmentPaths.length > 1) {
      videoPath = clip.crossfade
        ? await crossfadeVideos({ videoPaths: segmentPaths, outputDir, clipId })
        : await concatenateVideos({ videoPaths: segmentPaths, outputDir, clipId });
    } else {
      videoPath = segmentPaths[0];
    }

    // Save videoPath on the clip and clear segment counter
    updateClip(clipId, { videoPath, currentSegment: undefined });

    // For presenter mode, the Veo video already contains speech — skip TTS/music/mux.
    // Veo sometimes bakes music/laughter into the audio despite the prompts, so
    // run a two-stage cleanup: Demucs source separation strips music/ambience even
    // underneath the voice, then RNNoise speech isolation scrubs any residue.
    // Both stages are best-effort — each failure falls through to the last good file.
    if (clip.mode === 'presenter') {
      console.log(`[pipeline] Presenter mode: skipping TTS/music, using Veo output directly`);
      updateClip(clipId, { status: 'muxing' });
      let finalPath = videoPath;
      try {
        finalPath = await separateVocals({ videoPath: finalPath, outputDir, clipId });
      } catch (err) {
        console.warn(
          `[pipeline] Vocal separation failed (non-fatal): ${(err as Error).message}`,
        );
      }
      try {
        finalPath = await isolateSpeech({ videoPath: finalPath, outputDir, clipId });
      } catch (err) {
        console.warn(
          `[pipeline] Speech isolation failed (non-fatal): ${(err as Error).message}`,
        );
      }
      updateClip(clipId, { finalPath, status: 'complete' });
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
