"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { FileInput } from "@astryxdesign/core/FileInput";

import PromptInput from "../components/PromptInput";
import DurationPicker from "../components/DurationPicker";
import PersonalityPicker from "../components/PersonalityPicker";
import type { PresenterPersonality } from "../components/PersonalityPicker";
import StatusTracker from "../components/StatusTracker";
import VideoPlayer from "../components/VideoPlayer";
import styles from "./page.module.css";

type ClipStatus =
  | "idle"
  | "uploading"
  | "preparing_script"
  | "script_ready"
  | "generating_video"
  | "generating_audio"
  | "generating_music"
  | "muxing"
  | "complete"
  | "error";

interface Clip {
  id: string;
  status: ClipStatus;
  error?: string;
  narrationScript?: string;
  caption?: string;
  currentSegment?: number;
  totalSegments?: number;
  finalPath?: string;
  videoPath?: string;
  enableNarration?: boolean;
  enableMusic?: boolean;
  mode?: "story" | "presenter";
}

async function getErrorMessage(res: Response): Promise<string> {
  try {
    const data = await res.json();
    return data.error || `Request failed with status ${res.status}`;
  } catch {
    try {
      const text = await res.text();
      return text || `Request failed with status ${res.status}`;
    } catch {
      return `Request failed with status ${res.status}`;
    }
  }
}

export default function PresenterModePage() {
  // Form state
  const [faceFile, setFaceFile] = useState<File | null>(null);
  const [storyText, setStoryText] = useState("");
  const [length, setLength] = useState(30);
  const [personality, setPersonality] = useState<PresenterPersonality>("social");

  // Generation state
  const [clip, setClip] = useState<Clip | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editedNarration, setEditedNarration] = useState("");
  const eventSourceRef = useRef<EventSource | null>(null);

  useEffect(() => {
    return () => {
      eventSourceRef.current?.close();
      if (pollingRef.current) clearInterval(pollingRef.current);
    };
  }, []);

  // Polling fallback
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
        // Ignore
      }
    }, 3000);
  }, []);

  const handleGenerateScript = useCallback(async () => {
    if (!storyText.trim()) return;
    setIsSubmitting(true);

    try {
      const formData = new FormData();
      if (faceFile) {
        formData.append("images", faceFile);
      }
      formData.append("storyText", storyText);
      formData.append("speakerVoice", "Puck");
      formData.append("length", String(length));
      formData.append("ensureContinuity", "true");
      formData.append("enableMusic", "false");
      formData.append("enableNarration", "false"); // Speech is in the Veo video directly
      formData.append("mode", "presenter");
      formData.append("presenterPersonality", personality);

      const createRes = await fetch("/api/clips", {
        method: "POST",
        body: formData,
      });

      if (!createRes.ok) {
        const errorMsg = await getErrorMessage(createRes);
        throw new Error(errorMsg);
      }

      const newClip: Clip = await createRes.json();
      setClip({ ...newClip, status: "preparing_script" });

      const scriptRes = await fetch(`/api/clips/${newClip.id}/script`, {
        method: "POST",
      });

      if (!scriptRes.ok) {
        const errorMsg = await getErrorMessage(scriptRes);
        throw new Error(errorMsg);
      }

      const updatedClip: Clip = await scriptRes.json();
      setClip(updatedClip);
      setEditedNarration(updatedClip.narrationScript ?? "");
    } catch (err) {
      setClip((prev) =>
        prev
          ? { ...prev, status: "error", error: (err as Error).message }
          : { id: "", status: "error", error: (err as Error).message },
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [faceFile, storyText, length, personality]);

  const handleGenerateVideo = useCallback(async () => {
    if (!clip || clip.status !== "script_ready") return;
    setIsSubmitting(true);

    try {
      const genRes = await fetch(`/api/clips/${clip.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ narrationScript: editedNarration }),
      });

      if (!genRes.ok) {
        const errorMsg = await getErrorMessage(genRes);
        throw new Error(errorMsg);
      }

      setClip((prev) => prev ? { ...prev, status: "generating_video" } : prev);

      eventSourceRef.current?.close();
      const es = new EventSource(
        `http://localhost:8080/api/clips/${clip.id}/events`,
      );
      eventSourceRef.current = es;

      es.onmessage = (event) => {
        try {
          const updated: Clip = JSON.parse(event.data);
          setClip(updated);
          if (updated.status === "complete" || updated.status === "error") {
            es.close();
          }
        } catch {
          // Ignore
        }
      };

      es.onerror = () => {
        es.close();
        startPolling(clip.id);
      };
    } catch (err) {
      setClip((prev) =>
        prev
          ? { ...prev, status: "error", error: (err as Error).message }
          : { id: "", status: "error", error: (err as Error).message },
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [clip, editedNarration, startPolling]);

  const handleRetry = useCallback(() => {
    if (!clip) return;
    setClip(null);
    setEditedNarration("");
    handleGenerateScript();
  }, [clip, handleGenerateScript]);

  const isGenerating =
    clip &&
    clip.status !== "idle" &&
    clip.status !== "script_ready" &&
    clip.status !== "complete" &&
    clip.status !== "error";
  const canGenerateScript =
    !!storyText.trim() && !isSubmitting && !isGenerating && clip?.status !== "script_ready";
  const canGenerateVideo =
    clip?.status === "script_ready" && !isSubmitting && !isGenerating;

  const finalVideoUrl = clip?.finalPath
    ? `/media/${clip.finalPath.split("/").pop()}`
    : clip?.videoPath
      ? `/media/${clip.videoPath.split("/").pop()}`
      : null;

  const showRightColumn = clip && clip.status !== "idle";

  // Face image preview
  const facePreviewUrl = faceFile ? URL.createObjectURL(faceFile) : null;

  return (
    <>
      <main className={styles.main}>
        <div className={styles.header}>
          <h1 className={styles.title}>Presenter Mode</h1>
          <p className={styles.subtitle}>
            Upload a face photo, paste your text, and AI will create a
            talking-head video on a green screen
          </p>
        </div>

        <div className={styles.grid}>
          {/* Left Column — Inputs & Settings */}
          <div className={styles.left}>
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>1. Presenter & Script</h2>
              <FileInput
                label="Face Photo"
                value={faceFile ? [faceFile] : []}
                onChange={(val) => {
                  if (!val) setFaceFile(null);
                  else if (Array.isArray(val)) setFaceFile(val[0] ?? null);
                  else setFaceFile(val);
                }}
                accept="image/*"
                mode="dropzone"
                maxFiles={1}
                description="Upload a clear photo of the person who will present"
              />

              {facePreviewUrl && (
                <div style={{ marginTop: "0.5rem", position: "relative" }}>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={facePreviewUrl}
                    alt="Face preview"
                    style={{
                      width: "100%",
                      borderRadius: "12px",
                      objectFit: "cover",
                      maxHeight: "300px",
                    }}
                  />
                  <button
                    onClick={() => setFaceFile(null)}
                    style={{
                      position: "absolute",
                      top: 8,
                      right: 8,
                      background: "rgba(0,0,0,0.6)",
                      color: "#fff",
                      border: "none",
                      borderRadius: "50%",
                      width: 28,
                      height: 28,
                      cursor: "pointer",
                      fontSize: "0.85rem",
                    }}
                  >
                    ✕
                  </button>
                </div>
              )}

              <PromptInput
                label="Story Text"
                value={storyText}
                onChange={setStoryText}
                placeholder="Paste the text your presenter should narrate — an article, notes, a script… The AI writes the narration from it."
                maxLength={100000}
                rows={12}
              />
            </div>

            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>2. Mood & Settings</h2>
              <PersonalityPicker value={personality} onChange={setPersonality} />
              <div className={styles.settings}>
                <DurationPicker value={length} onChange={setLength} />
              </div>
            </div>

            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>3. Generate</h2>
              {editedNarration && (
                <div className={styles.scriptPreview}>
                  <label>Presenter Script</label>
                  <textarea
                    value={editedNarration}
                    onChange={(e) => setEditedNarration(e.target.value)}
                    readOnly={clip?.status !== "script_ready"}
                  />
                </div>
              )}

              {clip?.status === "script_ready" ? (
                <Button
                  variant="primary"
                  size="lg"
                  label={isSubmitting ? "Submitting…" : "🎬 Generate Video"}
                  isDisabled={!canGenerateVideo}
                  clickAction={handleGenerateVideo}
                />
              ) : (
                <Button
                  variant="primary"
                  size="lg"
                  label={
                    isSubmitting
                      ? "Submitting…"
                      : isGenerating
                        ? "⏳ Generating…"
                        : "✨ Generate Script"
                  }
                  isDisabled={!canGenerateScript}
                  clickAction={handleGenerateScript}
                />
              )}

              {clip?.status === "error" && clip.error && (
                <Banner
                  status="error"
                  title="Generation failed"
                  onDismiss={() => setClip(null)}
                >
                  {clip.error}
                </Banner>
              )}
            </div>
          </div>

          {/* Right Column — Stage */}
          <div className={styles.right}>
            {clip && clip.status !== "idle" && clip.status !== "script_ready" && (
              <div className={styles.statusBar}>
                <StatusTracker
                  status={clip.status}
                  error={clip.error}
                  currentSegment={clip.currentSegment}
                  totalSegments={clip.totalSegments}
                  enableNarration={false}
                  enableMusic={false}
                  onRetry={handleRetry}
                />
              </div>
            )}

            {clip?.status === "complete" && finalVideoUrl ? (
              <div className={styles.resultSection}>
                <VideoPlayer src={finalVideoUrl} />
                <a
                  href={finalVideoUrl}
                  download={`veoclip_presenter_${clip.id}.mp4`}
                  className={`btn-primary ${styles.downloadBtn}`}
                >
                  <span>⬇ Download Video</span>
                </a>

                {clip.caption && (
                  <div className={styles.captionBox}>
                    <label className={styles.captionLabel}>
                      TikTok Caption
                    </label>
                    <p className={styles.captionText}>{clip.caption}</p>
                    <Button
                      variant="secondary"
                      label="📋 Copy Caption"
                      clickAction={() => {
                        navigator.clipboard.writeText(clip.caption!);
                      }}
                    />
                  </div>
                )}
              </div>
            ) : (!clip || clip.status === "idle" || clip.status === "script_ready") && (
              <div className={styles.emptyState}>
                <div style={{ fontSize: "3rem", marginBottom: "0.5rem" }}>🎙️</div>
                <h3>Presenter Studio</h3>
                <p>Upload a face and script on the left to bring your presenter to life.</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
