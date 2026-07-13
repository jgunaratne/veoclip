"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import Navbar from "./components/Navbar";
import ImageUpload from "./components/ImageUpload";
import PromptInput from "./components/PromptInput";
import VoiceSelector from "./components/VoiceSelector";
import DurationPicker from "./components/DurationPicker";
import StatusTracker from "./components/StatusTracker";
import VideoPlayer from "./components/VideoPlayer";
import styles from "./page.module.css";

type ClipStatus =
  | "idle"
  | "uploading"
  | "preparing_script"
  | "generating_video"
  | "generating_audio"
  | "muxing"
  | "complete"
  | "error";

interface Clip {
  id: string;
  status: ClipStatus;
  error?: string;
  narrationScript?: string;
  currentSegment?: number;
  totalSegments?: number;
  finalPath?: string;
  videoPath?: string;
}

export default function CreatePage() {
  // Form state
  const [files, setFiles] = useState<File[]>([]);
  const [storyText, setStoryText] = useState("");
  const [voice, setVoice] = useState("Puck");
  const [characterProfile, setCharacterProfile] = useState("");
  const [isCharacterSuggesting, setIsCharacterSuggesting] = useState(false);
  const [length, setLength] = useState(30);
  const [ensureContinuity, setEnsureContinuity] = useState(false);

  // Track whether the user has manually edited the character field
  const userEditedCharacter = useRef(false);

  // Auto-suggest a narrator character when text is pasted (debounced)
  useEffect(() => {
    // Only auto-suggest if: text is substantial, user hasn't typed their own,
    // and we haven't already suggested one for this text
    if (storyText.length < 100 || userEditedCharacter.current) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setIsCharacterSuggesting(true);
      try {
        const res = await fetch("/api/suggest-character", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ storyText }),
          signal: controller.signal,
        });
        if (res.ok) {
          const data = await res.json();
          if (data.characterProfile && !userEditedCharacter.current) {
            setCharacterProfile(data.characterProfile);
          }
        }
      } catch {
        // Ignore — suggestion is best-effort
      } finally {
        setIsCharacterSuggesting(false);
      }
    }, 1500);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [storyText]);

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

  const handleGenerate = useCallback(async () => {
    if (!storyText.trim()) return;
    setIsSubmitting(true);

    try {
      // 1. Create clip via multipart POST
      const formData = new FormData();
      for (const file of files) {
        formData.append("images", file);
      }
      formData.append("storyText", storyText);
      formData.append("speakerVoice", voice);
      formData.append("length", String(length));
      formData.append("ensureContinuity", String(ensureContinuity));
      if (characterProfile.trim()) {
        formData.append("characterProfile", characterProfile.trim());
      }

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
      setClip({ ...newClip, status: "preparing_script" });

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
  }, [files, storyText, voice, length, ensureContinuity, characterProfile, startPolling]);

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
  const canGenerate = storyText.trim() && !isSubmitting && !isGenerating;

  // Determine final video URL
  const finalVideoUrl = clip?.finalPath
    ? `/media/${clip.finalPath.split("/").pop()}`
    : clip?.videoPath
      ? `/media/${clip.videoPath.split("/").pop()}`
      : null;

  const showRightColumn =
    clip && clip.status !== "idle";

  return (
    <>
      <Navbar />
      <main className={styles.main}>
        <div className={styles.header}>
          <h1 className={styles.title}>Create a Story Video</h1>
          <p className={styles.subtitle}>
            Paste your text, add images, and get a narrated vertical video
            ready for social media
          </p>
        </div>

        <div className={styles.grid}>
          {/* Full-width status bar — spans all 3 columns */}
          {clip && clip.status !== "idle" && (
            <div className={styles.statusBar}>
              <StatusTracker
                status={clip.status}
                error={clip.error}
                currentSegment={clip.currentSegment}
                totalSegments={clip.totalSegments}
                onRetry={handleRetry}
              />
            </div>
          )}

          {/* Column 1 — Images */}
          <div className={styles.left}>
            <ImageUpload files={files} onFilesChange={setFiles} />
          </div>

          {/* Column 2 — Story text + controls */}
          <div className={styles.middle}>
            <PromptInput
              label="Story Text"
              value={storyText}
              onChange={setStoryText}
              placeholder="Paste the text your story should be based on — an article, notes, a chapter… The AI writes the narration and scenes from it."
              maxLength={100000}
              rows={20}
            />

            <div className={styles.settings}>
              <DurationPicker value={length} onChange={setLength} />
              <VoiceSelector value={voice} onChange={setVoice} />
            </div>

            <PromptInput
              label={isCharacterSuggesting ? "Narrator Character — suggesting…" : "Narrator Character (auto-suggested)"}
              value={characterProfile}
              onChange={(val) => {
                userEditedCharacter.current = val.length > 0;
                setCharacterProfile(val);
              }}
              placeholder="Describe the narrator’s persona — e.g. ‘A grizzled war correspondent with decades of field experience, speaking with gravitas and urgency’. Leave empty for a neutral narrator."
              maxLength={2000}
              rows={3}
            />

            <CheckboxInput
              label="Ensure visual continuity between scenes"
              description="Tightly links visual flow between scenes (generates sequentially, takes 10-20 minutes). If disabled, scenes generate in parallel (takes ~2 minutes)."
              value={ensureContinuity}
              onChange={(checked) => setEnsureContinuity(checked)}
            />

            <Button
              variant="primary"
              size="lg"
              label={
                isSubmitting
                  ? "Submitting…"
                  : isGenerating
                    ? "⏳ Generating…"
                    : "✨ Generate Story Video"
              }
              isDisabled={!canGenerate}
              clickAction={handleGenerate}
            />

            {/* Inline error banner */}
            {clip?.status === "error" && clip.error && (
              <Banner status="error" title="Generation failed" onDismiss={() => setClip(null)}>
                {clip.error}
              </Banner>
            )}
          </div>

          {/* Column 3 — Video (shown when complete) */}
          <div className={styles.right}>
            {clip?.status === "complete" && finalVideoUrl && (
              <div className={styles.resultSection}>
                <VideoPlayer src={finalVideoUrl} />
                <a
                  href={finalVideoUrl}
                  download={`veoclip_${clip.id}.mp4`}
                  className={`btn-primary ${styles.downloadBtn}`}
                >
                  <span>⬇ Download Video</span>
                </a>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
