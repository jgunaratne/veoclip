"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
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
  musicPrompt?: string;
}

export default function CreatePage() {
  // Form state
  const [files, setFiles] = useState<File[]>([]);
  const [storyText, setStoryText] = useState("");
  const [voice, setVoice] = useState("Puck");
  const [enableNarration, setEnableNarration] = useState(true);
  const [useCustomVoice, setUseCustomVoice] = useState(false);
  const [characterProfile, setCharacterProfile] = useState("");
  const [isCharacterSuggesting, setIsCharacterSuggesting] = useState(false);
  const [length, setLength] = useState(30);
  const [ensureContinuity, setEnsureContinuity] = useState(false);
  const [enableMusic, setEnableMusic] = useState(true);
  const [musicPrompt, setMusicPrompt] = useState("");
  const [isMusicPromptSuggesting, setIsMusicPromptSuggesting] = useState(false);

  // Generate a narrator character on-demand via button click
  const suggestCharacterRef = useRef<AbortController | null>(null);
  const handleSuggestCharacter = useCallback(async () => {
    if (!storyText.trim() || isCharacterSuggesting) return;
    suggestCharacterRef.current?.abort();
    const controller = new AbortController();
    suggestCharacterRef.current = controller;
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
        if (data.characterProfile) {
          setCharacterProfile(data.characterProfile);
        }
      }
    } catch {
      // Ignore — suggestion is best-effort
    } finally {
      setIsCharacterSuggesting(false);
    }
  }, [storyText, isCharacterSuggesting]);

  // Generate a music prompt on-demand via button click
  const suggestMusicRef = useRef<AbortController | null>(null);
  const handleSuggestMusicPrompt = useCallback(async () => {
    if (!storyText.trim() || isMusicPromptSuggesting) return;
    suggestMusicRef.current?.abort();
    const controller = new AbortController();
    suggestMusicRef.current = controller;
    setIsMusicPromptSuggesting(true);
    try {
      const res = await fetch("/api/suggest-music-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storyText }),
        signal: controller.signal,
      });
      if (res.ok) {
        const data = await res.json();
        if (data.musicPrompt) {
          setMusicPrompt(data.musicPrompt);
        }
      }
    } catch {
      // Ignore — suggestion is best-effort
    } finally {
      setIsMusicPromptSuggesting(false);
    }
  }, [storyText, isMusicPromptSuggesting]);

  // Generation state
  const [clip, setClip] = useState<Clip | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editedNarration, setEditedNarration] = useState("");
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

  const handleGenerateScript = useCallback(async () => {
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
      formData.append("enableMusic", String(enableMusic));
      formData.append("enableNarration", String(enableNarration));
      if (useCustomVoice && characterProfile.trim() && enableNarration) {
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
      // Show preparing status immediately
      setClip({ ...newClip, status: "preparing_script" });

      // 2. Generate script only
      const scriptRes = await fetch(`/api/clips/${newClip.id}/script`, {
        method: "POST",
      });

      if (!scriptRes.ok) {
        const err = await scriptRes.json();
        throw new Error(err.error || "Failed to generate script");
      }

      const updatedClip: Clip = await scriptRes.json();
      setClip(updatedClip);
      setEditedNarration(updatedClip.narrationScript ?? "");
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
  }, [files, storyText, voice, length, ensureContinuity, enableMusic, enableNarration, useCustomVoice, characterProfile]);

  const handleGenerateVideo = useCallback(async () => {
    if (!clip || clip.status !== "script_ready") return;
    setIsSubmitting(true);

    try {
      // 1. Start generation with the (possibly edited) narration
      const genRes = await fetch(`/api/clips/${clip.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ narrationScript: editedNarration, musicPrompt }),
      });

      if (!genRes.ok) {
        const err = await genRes.json();
        throw new Error(err.error || "Failed to start generation");
      }

      setClip((prev) => prev ? { ...prev, status: "generating_video" } : prev);

      // 2. Open SSE directly to backend (bypass Next.js proxy which buffers SSE)
      eventSourceRef.current?.close();
      const es = new EventSource(
        `http://localhost:8080/api/clips/${clip.id}/events`,
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
        startPolling(clip.id);
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
  }, [clip, editedNarration, musicPrompt, startPolling]);

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
          {clip && clip.status !== "idle" && clip.status !== "script_ready" && (
            <div className={styles.statusBar}>
              <StatusTracker
                status={clip.status}
                error={clip.error}
                currentSegment={clip.currentSegment}
                totalSegments={clip.totalSegments}
                enableNarration={clip.enableNarration}
                enableMusic={clip.enableMusic}
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
              {enableNarration && <VoiceSelector value={voice} onChange={setVoice} />}
            </div>

            <CheckboxInput
              label="Add voiceover narration"
              description="Generates custom spoken narration text-to-speech drawn from the story."
              value={enableNarration}
              onChange={(checked) => setEnableNarration(checked)}
            />

            {enableNarration && (
              <>
                <CheckboxInput
                  label="Use custom character voice"
                  description="Give the narrator a distinct persona — tone, pacing, and personality."
                  value={useCustomVoice}
                  onChange={(checked) => setUseCustomVoice(checked)}
                />

                {useCustomVoice && (
                  <div className={styles.characterSection}>
                    <PromptInput
                      label={isCharacterSuggesting ? "Narrator Character — generating…" : "Narrator Character"}
                      value={characterProfile}
                      onChange={setCharacterProfile}
                      placeholder="Describe the narrator's persona — e.g. 'A grizzled war correspondent with decades of field experience, speaking with gravitas and urgency'."
                      maxLength={2000}
                      rows={3}
                    />
                    <Button
                      variant="secondary"
                      label={isCharacterSuggesting ? "Generating…" : "✨ Auto-generate from text"}
                      isDisabled={!storyText.trim() || isCharacterSuggesting}
                      clickAction={handleSuggestCharacter}
                    />
                  </div>
                )}
              </>
            )}

            <CheckboxInput
              label="Ensure visual continuity between scenes"
              description="Tightly links visual flow between scenes (generates sequentially, takes 10-20 minutes). If disabled, scenes generate in parallel (takes ~2 minutes)."
              value={ensureContinuity}
              onChange={(checked) => setEnsureContinuity(checked)}
            />

            <CheckboxInput
              label="Add background music"
              description="Generates a soft, atmospheric instrumental score via Lyria 3 and mixes it under the narration."
              value={enableMusic}
              onChange={(checked) => setEnableMusic(checked)}
            />

            {enableMusic && (
              <div className={styles.characterSection}>
                <PromptInput
                  label={isMusicPromptSuggesting ? "Music Prompt — generating…" : "Music Prompt"}
                  value={musicPrompt}
                  onChange={setMusicPrompt}
                  placeholder="Describe the mood and style of background music — e.g. 'Warm, nostalgic acoustic guitar with soft strings, evoking a sunset road trip'"
                  maxLength={2000}
                  rows={2}
                />
                <Button
                  variant="secondary"
                  label={isMusicPromptSuggesting ? "Generating…" : "✨ Auto-generate from text"}
                  isDisabled={!storyText.trim() || isMusicPromptSuggesting}
                  clickAction={handleSuggestMusicPrompt}
                />
              </div>
            )}

            {editedNarration && (
              <div className={styles.scriptPreview}>
                <label>Narration Script</label>
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

                {clip.caption && (
                  <div className={styles.captionBox}>
                    <label className={styles.captionLabel}>TikTok Caption</label>
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
            )}
          </div>
        </div>
      </main>
    </>
  );
}
