"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import Navbar from "../components/Navbar";
import ImageUpload from "../components/ImageUpload";
import PromptInput from "../components/PromptInput";
import VoiceSelector from "../components/VoiceSelector";
import DurationPicker from "../components/DurationPicker";
import StatusTracker from "../components/StatusTracker";
import VideoPlayer from "../components/VideoPlayer";
import styles from "./page.module.css";

type ClipStatus =
  | "idle"
  | "uploading"
  | "generating_video"
  | "generating_audio"
  | "muxing"
  | "complete"
  | "error";

interface Clip {
  id: string;
  status: ClipStatus;
  error?: string;
  finalPath?: string;
  videoPath?: string;
}

export default function CreatePage() {
  // Form state
  const [file, setFile] = useState<File | null>(null);
  const [videoPrompt, setVideoPrompt] = useState("");
  const [voiceoverScript, setVoiceoverScript] = useState("");
  const [voice, setVoice] = useState("en-US-Journey-D");
  const [duration, setDuration] = useState(5);

  // Generation state
  const [clip, setClip] = useState<Clip | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);

  // Clean up SSE on unmount
  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  const handleGenerate = useCallback(async () => {
    if (!file || !videoPrompt.trim()) return;
    setIsSubmitting(true);

    try {
      // 1. Create clip via multipart POST
      const formData = new FormData();
      formData.append("image", file);
      formData.append("videoPrompt", videoPrompt);
      formData.append("voiceoverScript", voiceoverScript);
      formData.append("speakerVoice", voice);
      formData.append("duration", String(duration));

      const createRes = await fetch("/api/clips", {
        method: "POST",
        body: formData,
      });

      if (!createRes.ok) {
        const err = await createRes.json();
        throw new Error(err.error || "Failed to create clip");
      }

      const newClip: Clip = await createRes.json();
      // Show generating status immediately
      setClip({ ...newClip, status: "generating_video" });

      // 2. Start generation
      const genRes = await fetch(`/api/clips/${newClip.id}/generate`, {
        method: "POST",
      });

      if (!genRes.ok) {
        const err = await genRes.json();
        throw new Error(err.error || "Failed to start generation");
      }

      // 3. Open SSE directly to backend (bypass Next.js proxy which buffers SSE)
      eventSourceRef.current?.close();
      const es = new EventSource(
        `http://localhost:8080/api/clips/${newClip.id}/events`,
      );
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const updated: Clip = JSON.parse(event.data);
          setClip(updated);

          // Close SSE when terminal state reached
          if (updated.status === "complete" || updated.status === "error") {
            es.close();
          }
        } catch {
          // Ignore parse errors
        }
      };

      es.onerror = () => {
        // SSE failed — fall back to polling
        es.close();
        startPolling(newClip.id);
      };
    } catch (err) {
      setClip((prev) =>
        prev
          ? { ...prev, status: "error", error: (err as Error).message }
          : {
              id: "",
              status: "error",
              error: (err as Error).message,
            },
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [file, videoPrompt, voiceoverScript, voice, duration]);

  // Polling fallback if SSE doesn't work
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const startPolling = useCallback((clipId: string) => {
    if (pollingRef.current) clearInterval(pollingRef.current);
    pollingRef.current = setInterval(async () => {
      try {
        const res = await fetch(`/api/clips/${clipId}`);
        if (!res.ok) return;
        const updated: Clip = await res.json();
        setClip(updated);
        if (updated.status === "complete" || updated.status === "error") {
          clearInterval(pollingRef.current!);
          pollingRef.current = null;
        }
      } catch {
        // Ignore fetch errors during polling
      }
    }, 3000);
  }, []);

  const handleRetry = useCallback(() => {
    if (!clip) return;
    setClip(null);
    handleGenerate();
  }, [clip, handleGenerate]);

  const isGenerating =
    clip &&
    clip.status !== "idle" &&
    clip.status !== "complete" &&
    clip.status !== "error";
  const canGenerate = file && videoPrompt.trim() && !isSubmitting && !isGenerating;

  // Determine final video URL
  const finalVideoUrl = clip?.finalPath
    ? `/media/${clip.finalPath.split("/").pop()}`
    : clip?.videoPath
      ? `/media/${clip.videoPath.split("/").pop()}`
      : null;

  return (
    <>
      <Navbar />
      <main className={styles.main}>
        <div className={styles.header}>
          <h1 className={styles.title}>Create a Clip</h1>
          <p className={styles.subtitle}>
            Upload an image, describe the motion, and add a voiceover
          </p>
        </div>

        <div className={styles.grid}>
          {/* Left column — Image */}
          <div className={styles.left}>
            <ImageUpload file={file} onFileChange={setFile} />
          </div>

          {/* Right column — Controls */}
          <div className={styles.right}>
            <PromptInput
              label="Video Prompt"
              value={videoPrompt}
              onChange={setVideoPrompt}
              placeholder="Describe the motion you want… e.g. 'Slow zoom into the forest, birds take flight across the sky'"
              maxLength={1000}
              rows={4}
            />

            <PromptInput
              label="Voiceover Script"
              value={voiceoverScript}
              onChange={setVoiceoverScript}
              placeholder="Write the narration to be spoken over the video… (optional)"
              maxLength={2000}
              rows={3}
            />

            <div className={styles.settings}>
              <DurationPicker value={duration} onChange={setDuration} />
              <VoiceSelector value={voice} onChange={setVoice} />
            </div>

            <button
              className={`btn-primary ${styles.generateBtn}`}
              disabled={!canGenerate}
              onClick={handleGenerate}
            >
              <span>
                {isSubmitting
                  ? "Submitting…"
                  : isGenerating
                    ? "⏳ Generating…"
                    : "✨ Generate Clip"}
              </span>
            </button>

            {/* Inline error banner */}
            {clip?.status === "error" && clip.error && (
              <div className={styles.errorBanner}>
                <span className={styles.errorIcon}>⚠️</span>
                <div className={styles.errorContent}>
                  <strong>Generation failed</strong>
                  <p>{clip.error}</p>
                </div>
                <button className={styles.errorDismiss} onClick={() => setClip(null)}>
                  ✕
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Status tracker */}
        {clip && clip.status !== "idle" && (
          <section className={styles.statusSection}>
            <StatusTracker
              status={clip.status}
              error={clip.error}
              onRetry={handleRetry}
            />
          </section>
        )}

        {/* Video player + download */}
        {clip?.status === "complete" && finalVideoUrl && (
          <section className={styles.resultSection}>
            <VideoPlayer src={finalVideoUrl} />
            <a
              href={finalVideoUrl}
              download={`veoclip_${clip.id}.mp4`}
              className={`btn-primary ${styles.downloadBtn}`}
            >
              <span>⬇ Download Clip</span>
            </a>
          </section>
        )}
      </main>
    </>
  );
}
