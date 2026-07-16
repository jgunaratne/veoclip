import type { Response } from 'express';
import fs from 'fs';
import path from 'path';
import type { Clip, ClipStatus } from './types/clip.js';

// ---------------------------------------------------------------------------
// Clip store — in-memory Map backed by a JSON file so clips (and the videos
// they point to in the output dir) survive server restarts.
// ---------------------------------------------------------------------------

const DATA_DIR = process.env.DATA_DIR || './data';
const STORE_FILE = path.join(DATA_DIR, 'clips.json');

const clips = new Map<string, Clip>();

// Statuses that describe a pipeline in flight. A restart kills the pipeline,
// so clips found in these states on load are marked as errored.
const IN_FLIGHT_STATUSES: ClipStatus[] = [
  'uploading',
  'preparing_script',
  'generating_video',
  'generating_audio',
  'generating_music',
  'muxing',
];

function loadClips(): void {
  try {
    if (!fs.existsSync(STORE_FILE)) return;
    const parsed = JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8')) as Clip[];
    for (const clip of parsed) {
      if (IN_FLIGHT_STATUSES.includes(clip.status)) {
        clip.status = 'error';
        clip.error = 'Generation was interrupted by a server restart';
        clip.currentSegment = undefined;
      }
      clips.set(clip.id, clip);
    }
    console.log(`[store] Loaded ${clips.size} clip(s) from ${STORE_FILE}`);
  } catch (err) {
    console.error(`[store] Failed to load ${STORE_FILE}:`, (err as Error).message);
  }
}

function persistClips(): void {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmpFile = `${STORE_FILE}.tmp`;
    fs.writeFileSync(tmpFile, JSON.stringify(Array.from(clips.values()), null, 2));
    fs.renameSync(tmpFile, STORE_FILE); // atomic — never leaves a half-written file
  } catch (err) {
    console.error(`[store] Failed to persist clips:`, (err as Error).message);
  }
}

loadClips();

export function getClip(id: string): Clip | undefined {
  return clips.get(id);
}

export function setClip(clip: Clip): void {
  clips.set(clip.id, clip);
  persistClips();
}

export function updateClip(
  id: string,
  partial: Partial<Clip>,
): Clip | undefined {
  const existing = clips.get(id);
  if (!existing) return undefined;

  const updated: Clip = {
    ...existing,
    ...partial,
    updatedAt: new Date().toISOString(),
  };
  clips.set(id, updated);
  persistClips();

  // Notify SSE subscribers whenever a clip changes
  notifyClipUpdate(id);

  return updated;
}

export function getAllClips(): Clip[] {
  return Array.from(clips.values());
}

export function deleteClip(id: string): boolean {
  sseClients.delete(id); // clean up any SSE subscribers
  const deleted = clips.delete(id);
  if (deleted) persistClips();
  return deleted;
}

// ---------------------------------------------------------------------------
// SSE subscriber management
// ---------------------------------------------------------------------------

const sseClients = new Map<string, Set<Response>>();

export function subscribeToClip(clipId: string, res: Response): void {
  if (!sseClients.has(clipId)) {
    sseClients.set(clipId, new Set());
  }
  sseClients.get(clipId)!.add(res);

  // Clean up when client disconnects
  res.on('close', () => {
    unsubscribeFromClip(clipId, res);
  });
}

export function unsubscribeFromClip(clipId: string, res: Response): void {
  const clients = sseClients.get(clipId);
  if (clients) {
    clients.delete(res);
    if (clients.size === 0) {
      sseClients.delete(clipId);
    }
  }
}

function notifyClipUpdate(clipId: string): void {
  const clip = clips.get(clipId);
  if (!clip) return;

  const clients = sseClients.get(clipId);
  if (!clients || clients.size === 0) return;

  const data = JSON.stringify(clip);

  for (const res of clients) {
    try {
      res.write(`data: ${data}\n\n`);
    } catch {
      // Client likely disconnected — remove it
      clients.delete(res);
    }
  }
}
