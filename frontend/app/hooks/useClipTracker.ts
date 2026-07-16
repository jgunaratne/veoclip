"use client";

import { useState, useRef, useCallback, useEffect } from "react";

// Statuses that mean the backend pipeline is still running. The pipeline is
// fire-and-forget on the server, so a page refresh doesn't stop it — we just
// need to reattach to the clip's event stream.
const IN_FLIGHT_STATUSES = new Set([
  "uploading",
  "preparing_script",
  "generating_video",
  "generating_audio",
  "generating_music",
  "muxing",
]);

// SSE connects directly to the backend — the Next.js proxy buffers SSE.
const BACKEND_SSE_BASE = "http://localhost:8080";

export function isInFlight(status: string): boolean {
  return IN_FLIGHT_STATUSES.has(status);
}

/**
 * Tracks a clip through the generation pipeline in a refresh-proof way.
 *
 * The active clip's ID is stored in localStorage under `storageKey`. On mount
 * the clip is re-fetched from the backend; if generation is still in flight
 * the hook reattaches SSE (with a polling fallback), so closing or refreshing
 * the page never loses a running generation.
 *
 * - `remember(id)`  — persist a clip ID as the page's active clip
 * - `watch(id)`     — remember + open SSE / polling for live status updates
 * - `reset()`       — stop watching and forget the active clip (the backend
 *                     pipeline keeps running; the video still lands in Videos)
 * - `onResume`      — called once with the clip recovered after a reload
 */
export function useClipTracker<C extends { id: string; status: string }>(
  storageKey: string,
  onResume?: (clip: C) => void,
) {
  const [clip, setClip] = useState<C | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Captured once — resume only happens on mount, so the first render's
  // callback is the one that matters
  const onResumeRef = useRef(onResume);

  const stopWatching = useCallback(() => {
    eventSourceRef.current?.close();
    eventSourceRef.current = null;
    if (pollingRef.current) {
      clearInterval(pollingRef.current);
      pollingRef.current = null;
    }
  }, []);

  const startPolling = useCallback(
    (clipId: string) => {
      if (pollingRef.current) clearInterval(pollingRef.current);
      pollingRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/clips/${clipId}`);
          if (!res.ok) return;
          const updated: C = await res.json();
          setClip(updated);
          if (updated.status === "complete" || updated.status === "error") {
            clearInterval(pollingRef.current!);
            pollingRef.current = null;
          }
        } catch {
          // Ignore fetch errors during polling
        }
      }, 3000);
    },
    [],
  );

  const remember = useCallback(
    (clipId: string) => {
      try {
        localStorage.setItem(storageKey, clipId);
      } catch {
        // localStorage unavailable — resume just won't work
      }
    },
    [storageKey],
  );

  const watch = useCallback(
    (clipId: string) => {
      remember(clipId);
      stopWatching();

      const es = new EventSource(`${BACKEND_SSE_BASE}/api/clips/${clipId}/events`);
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const updated: C = JSON.parse(event.data);
          setClip(updated);
          if (updated.status === "complete" || updated.status === "error") {
            es.close();
          }
        } catch {
          // Ignore parse errors
        }
      };

      es.onerror = () => {
        // SSE failed — fall back to polling through the Next.js proxy
        es.close();
        startPolling(clipId);
      };
    },
    [remember, stopWatching, startPolling],
  );

  const reset = useCallback(() => {
    stopWatching();
    try {
      localStorage.removeItem(storageKey);
    } catch {
      // Ignore
    }
    setClip(null);
  }, [storageKey, stopWatching]);

  // On mount: recover the active clip from a previous page load
  useEffect(() => {
    let cancelled = false;
    const clipId = (() => {
      try {
        return localStorage.getItem(storageKey);
      } catch {
        return null;
      }
    })();

    if (clipId) {
      (async () => {
        // Retry a few times — the backend may be mid-restart when the page
        // loads, and silently giving up would hide an errored clip from the
        // returning user.
        for (let attempt = 0; attempt < 3 && !cancelled; attempt++) {
          try {
            const res = await fetch(`/api/clips/${clipId}`);
            if (res.status === 404) {
              // Clip was deleted — forget it
              localStorage.removeItem(storageKey);
              return;
            }
            if (!res.ok) throw new Error(`status ${res.status}`);
            const recovered: C = await res.json();
            if (cancelled) return;
            setClip(recovered);
            onResumeRef.current?.(recovered);
            if (isInFlight(recovered.status)) watch(recovered.id);
            return;
          } catch {
            // Backend unreachable — wait and retry; keep the stored ID so a
            // later reload can still resume
            await new Promise((r) => setTimeout(r, 2000));
          }
        }
      })();
    }

    return () => {
      cancelled = true;
      stopWatching();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storageKey]);

  return { clip, setClip, remember, watch, reset };
}
