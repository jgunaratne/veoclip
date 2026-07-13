export type ClipStatus =
  | 'idle'
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
  storyText: string; // pasted source text the story is written from
  referenceImagePaths: string[]; // local filesystem paths (0..n images)
  speakerVoice: string;
  characterProfile?: string; // persona description — shapes how the TTS narrates
  enableMusic?: boolean; // generate background music via Lyria
  length: StoryLength; // 30, 60 or 180 seconds
  ensureContinuity?: boolean;

  // Generated story (filled in by the pipeline)
  narrationScript?: string;
  scenePrompts?: string[];
  caption?: string; // TikTok/social media caption

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
