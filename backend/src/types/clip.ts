export type ClipStatus =
  | 'idle'
  | 'uploading'
  | 'generating_video'
  | 'generating_audio'
  | 'muxing'
  | 'complete'
  | 'error';

export interface Clip {
  id: string;
  createdAt: string;
  updatedAt: string;

  // Inputs
  referenceImagePath: string; // local filesystem path
  videoPrompt: string;
  voiceoverScript: string;
  speakerVoice: string;
  duration: number; // 5 or 8

  // Status
  status: ClipStatus;
  error?: string;

  // Outputs (local file paths, served via /media/ endpoint)
  videoPath?: string;
  audioPath?: string;
  finalPath?: string;
}
