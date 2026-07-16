export type ClipStatus =
  | 'idle'
  | 'script_ready'
  | 'uploading'
  | 'preparing_script'
  | 'generating_video'
  | 'generating_audio'
  | 'generating_music'
  | 'muxing'
  | 'complete'
  | 'error';

/** User-selectable story length in seconds. Veo segments are a fixed 8 s,
 *  so each option maps to a segment count. */
export type StoryLength = 30 | 60 | 180;

/** Presenter personality / mood — controls tone of the script and Veo prompt. */
export type PresenterPersonality =
  | 'social'    // upbeat social-media creator (default / legacy)
  | 'calm'      // relaxed, measured, soothing
  | 'pensive'   // reflective, thoughtful
  | 'happy'     // bright, cheerful, smiling
  | 'energetic' // high-energy, fast-paced
  | 'serious'   // authoritative, no-nonsense
  | 'witty'     // clever, dry humor
  | 'warm'      // friendly, empathetic, inviting
  | 'intense';  // passionate, driven, urgent

/** Presenter script style — controls structure & framing of the narration content. */
export type PresenterStyle =
  | 'social_media'  // quick-hit social content (default)
  | 'personal'      // first-person personal story / anecdote
  | 'news'          // objective news report / briefing
  | 'educational'   // teaching / explainer
  | 'storytelling'  // narrative third-person story
  | 'review'        // product / experience review
  | 'motivational'; // inspirational / self-help

/** Presenter voice shaping — prompt-driven, layered on top of the
 *  personality's default voice description. 'default' leaves it untouched. */
export type VoiceAge = 'default' | 'gen_z' | 'millennial' | 'gen_x' | 'mature';
export type VoicePitch = 'default' | 'very_low' | 'low' | 'high' | 'very_high';
export type VoiceTexture = 'default' | 'raspy' | 'breathy' | 'husky' | 'bright';
export type VoiceAccent = 'default' | 'american' | 'british' | 'german' | 'french' | 'spanish';

export const SEGMENT_DURATION = 8; // seconds (Veo max)

export const SEGMENT_COUNTS: Record<StoryLength, number> = {
  30: 4, // 32 s
  60: 8, // 64 s
  180: 23, // 184 s
};

export interface Clip {
  id: string;
  createdAt: string;
  updatedAt: string;

  // Inputs
  title?: string; // short human-readable title derived from story text
  storyText: string; // pasted source text the story is written from
  referenceImagePaths: string[]; // local filesystem paths (0..n images)
  speakerVoice: string;
  characterProfile?: string; // persona description — shapes how the TTS narrates
  enableMusic?: boolean; // generate background music via Lyria
  enableNarration?: boolean; // enable voiceover narration
  length: StoryLength; // 30, 60 or 180 seconds
  ensureContinuity?: boolean;
  crossfade?: boolean; // crossfade between segments instead of hard cuts
  mode?: 'story' | 'presenter' | 'composite';
  presenterPersonality?: PresenterPersonality;
  presenterStyle?: PresenterStyle;
  voiceAge?: VoiceAge;
  voicePitch?: VoicePitch;
  voiceTexture?: VoiceTexture;
  voiceAccent?: VoiceAccent;

  // Generated story (filled in by the pipeline)
  narrationScript?: string;
  narrationSegments?: string[]; // presenter mode: per-8s-segment speech, sentence-aligned
  scenePrompts?: string[];
  caption?: string; // TikTok/social media caption
  musicPrompt?: string; // user-editable prompt for background music generation

  // Status
  status: ClipStatus;
  error?: string;
  currentSegment?: number; // 1-based, while generating_video
  totalSegments?: number;

  // Outputs (local file paths, served via /media/ endpoint)
  videoPath?: string;
  audioPath?: string;
  finalPath?: string;
}
