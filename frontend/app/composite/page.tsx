"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { FileInput } from "@astryxdesign/core/FileInput";
import VideoPlayer from "../components/VideoPlayer";
import styles from "./page.module.css";

interface VideoEntry {
  id: string;
  title: string;
  mode: "story" | "presenter" | "composite";
  createdAt: string;
  url: string;
  length: number;
}

interface CompositeClip {
  id: string;
  status: string;
  error?: string;
  finalPath?: string;
}

async function getErrorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data.error || `Request failed with status ${res.status}`;
  } catch {
    return `Request failed with status ${res.status}`;
  }
}

export default function CompositePage() {
  const [videos, setVideos] = useState<VideoEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [presenterId, setPresenterId] = useState<string | null>(null);
  const [backgroundId, setBackgroundId] = useState<string | null>(null);
  const [backgroundFile, setBackgroundFile] = useState<File | null>(null);

  const [job, setJob] = useState<CompositeClip | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [presenterScale, setPresenterScale] = useState(40);
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    fetch("/api/videos")
      .then(async (res) => {
        if (!res.ok) throw new Error(await getErrorMessage(res));
        setVideos(await res.json());
      })
      .catch((err) => setLoadError((err as Error).message));
    return () => {
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  const presenters = videos.filter((v) => v.mode === "presenter");
  const backgrounds = videos.filter((v) => v.mode !== "presenter");

  const startPolling = useCallback((clipId: string) => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/clips/${clipId}`);
        if (!res.ok) return;
        const updated: CompositeClip = await res.json();
        setJob(updated);
        if (updated.status === "complete" || updated.status === "error") {
          clearInterval(pollingRef.current!);
          pollingRef.current = null;
        }
      } catch {
        // Ignore
      }
    }, 2000);
  }, []);

  const handleComposite = useCallback(async () => {
    if (!presenterId || (!backgroundId && !backgroundFile)) return;
    setIsSubmitting(true);
    setJob(null);

    try {
      const formData = new FormData();
      formData.append("presenterClipId", presenterId);
      if (backgroundFile) {
        formData.append("background", backgroundFile);
      } else if (backgroundId) {
        formData.append("backgroundClipId", backgroundId);
      }
      formData.append("presenterScale", String(presenterScale / 100));

      const res = await fetch("/api/composite", { method: "POST", body: formData });
      if (!res.ok) throw new Error(await getErrorMessage(res));

      const clip: CompositeClip = await res.json();
      setJob(clip);
      startPolling(clip.id);
    } catch (err) {
      setJob({ id: "", status: "error", error: (err as Error).message });
    } finally {
      setIsSubmitting(false);
    }
  }, [presenterId, backgroundId, backgroundFile, presenterScale, startPolling]);

  const resultUrl = job?.status === "complete" && job.finalPath
    ? `/media/${job.finalPath.split("/").pop()}`
    : null;
  const isRunning = job !== null && job.status !== "complete" && job.status !== "error";
  const canComposite = !!presenterId && (!!backgroundId || !!backgroundFile) && !isSubmitting && !isRunning;

  return (
    <main className={styles.main}>
      <div className={styles.header}>
        <h1 className={styles.title}>Composite</h1>
        <p className={styles.subtitle}>
          Put a presenter in front of any background — the green screen is
          removed so the background video shows through
        </p>
      </div>

      {loadError && (
        <Banner status="error" title="Could not load videos">{loadError}</Banner>
      )}

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>1. Choose a presenter video</h2>
        {presenters.length === 0 ? (
          <p className={styles.empty}>No presenter videos yet — create one in Presenter Mode first.</p>
        ) : (
          <div className={styles.grid}>
            {presenters.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`${styles.card} ${presenterId === v.id ? styles.cardActive : ""}`}
                onClick={() => setPresenterId(presenterId === v.id ? null : v.id)}
              >
                {/* eslint-disable-next-line @next/next/no-video-component */}
                <video src={v.url} className={styles.cardVideo} muted preload="metadata" />
                <span className={styles.cardTitle}>{v.title}</span>
                <span className={styles.cardMeta}>{v.length}s</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>2. Choose a background</h2>
        {backgrounds.length > 0 && (
          <div className={styles.grid}>
            {backgrounds.map((v) => (
              <button
                key={v.id}
                type="button"
                className={`${styles.card} ${backgroundId === v.id ? styles.cardActive : ""}`}
                onClick={() => {
                  setBackgroundId(backgroundId === v.id ? null : v.id);
                  setBackgroundFile(null);
                }}
              >
                {/* eslint-disable-next-line @next/next/no-video-component */}
                <video src={v.url} className={styles.cardVideo} muted preload="metadata" />
                <span className={styles.cardTitle}>{v.title}</span>
                <span className={styles.cardMeta}>{v.length}s</span>
              </button>
            ))}
          </div>
        )}
        <FileInput
          label={backgrounds.length > 0 ? "…or upload a background video" : "Upload a background video"}
          value={backgroundFile ? [backgroundFile] : []}
          onChange={(val) => {
            const file = !val ? null : Array.isArray(val) ? (val[0] ?? null) : val;
            setBackgroundFile(file);
            if (file) setBackgroundId(null);
          }}
          accept="video/*"
          mode="dropzone"
          maxFiles={1}
          description="Any video file — it loops if it's shorter than the presenter video"
        />
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>3. Presenter Size</h2>
        <div className={styles.sliderRow}>
          <input
            type="range"
            min={10}
            max={100}
            step={5}
            value={presenterScale}
            onChange={(e) => setPresenterScale(Number(e.target.value))}
            className={styles.slider}
          />
          <span className={styles.sliderLabel}>{presenterScale}%</span>
        </div>
        <p className={styles.sliderHint}>
          Presenter height as a percentage of the video frame
        </p>
      </div>

      <div className={styles.section}>
        <h2 className={styles.sectionTitle}>4. Composite</h2>
        <Button
          variant="primary"
          size="lg"
          label={isSubmitting ? "Submitting…" : isRunning ? "⏳ Compositing…" : "🎭 Composite Video"}
          isDisabled={!canComposite}
          clickAction={handleComposite}
        />

        {job?.status === "error" && (
          <Banner status="error" title="Composite failed" onDismiss={() => setJob(null)}>
            {job.error || "Unknown error"}
          </Banner>
        )}

        {resultUrl && (
          <div className={styles.result}>
            <VideoPlayer src={resultUrl} />
            <a
              href={resultUrl}
              download={`veoclip_composite_${job!.id}.mp4`}
              className={`btn-primary ${styles.downloadBtn}`}
            >
              <span>⬇ Download Video</span>
            </a>
          </div>
        )}
      </div>
    </main>
  );
}
