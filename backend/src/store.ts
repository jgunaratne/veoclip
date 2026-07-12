import type { Response } from 'express';
import type { Clip, ClipStatus } from './types/clip.js';

// ---------------------------------------------------------------------------
// In-memory clip store
// ---------------------------------------------------------------------------

const clips = new Map<string, Clip>();

export function getClip(id: string): Clip | undefined {
  return clips.get(id);
}

export function setClip(clip: Clip): void {
  clips.set(clip.id, clip);
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

  // Notify SSE subscribers whenever a clip changes
  notifyClipUpdate(id);

  return updated;
}

export function getAllClips(): Clip[] {
  return Array.from(clips.values());
}

export function deleteClip(id: string): boolean {
  sseClients.delete(id); // clean up any SSE subscribers
  return clips.delete(id);
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
