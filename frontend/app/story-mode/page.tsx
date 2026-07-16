"use client";

import { useState, useRef, useCallback, useEffect } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";

import { useClipTracker, isInFlight } from "../hooks/useClipTracker";
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
  statusMessage?: string;
  narrationScript?: string;
  caption?: string;
  currentSegment?: number;
  totalSegments?: number;
  finalPath?: string;
  videoPath?: string;
  enableNarration?: boolean;
  enableMusic?: boolean;
  musicPrompt?: string;
  // Inputs echoed back by the backend — used to restore the form on resume
  storyText?: string;
  speakerVoice?: string;
  characterProfile?: string;
  length?: number;
  ensureContinuity?: boolean;
  crossfade?: boolean;
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
  const [crossfade, setCrossfade] = useState(false);
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

  // Generation state — the tracker persists the active clip ID in
  // localStorage and reattaches to the still-running backend pipeline after
  // a page refresh or a closed browser tab.
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editedNarration, setEditedNarration] = useState("");

  const { clip, setClip, remember, watch, reset } = useClipTracker<Clip>(
    "veoclip.activeClip.story",
    (recovered) => {
      // Restore the form so the user can edit/retry after a reload
      if (recovered.storyText) setStoryText(recovered.storyText);
      if (recovered.speakerVoice) setVoice(recovered.speakerVoice);
      if (recovered.length) setLength(recovered.length);
      if (recovered.enableNarration !== undefined) setEnableNarration(recovered.enableNarration);
      if (recovered.enableMusic !== undefined) setEnableMusic(recovered.enableMusic);
      if (recovered.musicPrompt) setMusicPrompt(recovered.musicPrompt);
      if (recovered.ensureContinuity !== undefined) setEnsureContinuity(recovered.ensureContinuity);
      if (recovered.crossfade !== undefined) setCrossfade(recovered.crossfade);
      if (recovered.characterProfile) {
        setCharacterProfile(recovered.characterProfile);
        setUseCustomVoice(true);
      }
      setEditedNarration(recovered.narrationScript ?? "");
    },
  );

  // If the script arrives via SSE (e.g. after resuming mid-preparation),
  // load it into the editable textarea
  useEffect(() => {
    if (clip?.status === "script_ready" && clip.narrationScript && !editedNarration) {
      setEditedNarration(clip.narrationScript);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip?.status]);

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
      formData.append("crossfade", String(crossfade));
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
        const errorMsg = await getErrorMessage(createRes);
        throw new Error(errorMsg);
      }

      const newClip: Clip = await createRes.json();
      // Remember the clip so a page refresh can pick it back up
      remember(newClip.id);
      // Show preparing status immediately
      setClip({ ...newClip, status: "preparing_script" });

      // 2. Generate script only
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
          : {
              id: "",
              status: "error",
              error: (err as Error).message,
            },
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [files, storyText, voice, length, ensureContinuity, crossfade, enableMusic, enableNarration, useCustomVoice, characterProfile, remember, setClip]);

  const handleGenerateVideo = useCallback(async () => {
    if (!clip || clip.status !== "script_ready") return;
    setIsSubmitting(true);

    try {
      // 1. Start generation with the (possibly edited) narration
      const genRes = await fetch(`/api/clips/${clip.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ narrationScript: editedNarration, musicPrompt, crossfade, ensureContinuity }),
      });

      if (!genRes.ok) {
        const errorMsg = await getErrorMessage(genRes);
        throw new Error(errorMsg);
      }

      setClip((prev) => prev ? { ...prev, status: "generating_video" } : prev);

      // 2. Track live status (SSE with polling fallback, refresh-proof)
      watch(clip.id);
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
  }, [clip, editedNarration, musicPrompt, crossfade, ensureContinuity, watch, setClip]);

  // Retry after an error. If the clip already has a script, re-run the same
  // pipeline (the backend allows restarting an errored clip); otherwise start
  // over from script generation.
  const handleRetry = useCallback(async () => {
    if (!clip) return;

    if (clip.id && clip.narrationScript) {
      setIsSubmitting(true);
      try {
        const res = await fetch(`/api/clips/${clip.id}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            narrationScript: editedNarration || clip.narrationScript,
            musicPrompt,
            crossfade,
            ensureContinuity,
          }),
        });
        if (!res.ok) throw new Error(await getErrorMessage(res));
        setClip((prev) => (prev ? { ...prev, status: "generating_video", error: undefined } : prev));
        watch(clip.id);
      } catch (err) {
        setClip((prev) =>
          prev ? { ...prev, status: "error", error: (err as Error).message } : prev,
        );
      } finally {
        setIsSubmitting(false);
      }
      return;
    }

    reset();
    setEditedNarration("");
    handleGenerateScript();
  }, [clip, editedNarration, musicPrompt, crossfade, ensureContinuity, watch, reset, setClip, handleGenerateScript]);

  // Clear the tracked clip (and any error) without touching the form.
  const handleReset = useCallback(() => {
    reset();
    setEditedNarration("");
  }, [reset]);

  // Stop a running generation — the backend pipeline aborts at its next
  // checkpoint and the clip is marked as stopped.
  const handleStop = useCallback(async () => {
    if (!clip?.id) return;
    try {
      const res = await fetch(`/api/clips/${clip.id}/cancel`, { method: "POST" });
      if (res.ok) {
        const updated: Clip = await res.json();
        setClip(updated);
      }
    } catch {
      // SSE/polling will surface the state
    }
  }, [clip, setClip]);

  // Reset every page setting back to its default and clear the tracked clip.
  // A pipeline that's still running keeps going on the server unless stopped;
  // its finished video shows up on the Videos page.
  const handleResetAll = useCallback(() => {
    reset();
    setFiles([]);
    setStoryText("");
    setVoice("Puck");
    setEnableNarration(true);
    setUseCustomVoice(false);
    setCharacterProfile("");
    setLength(30);
    setEnsureContinuity(false);
    setCrossfade(false);
    setEnableMusic(true);
    setMusicPrompt("");
    setEditedNarration("");
  }, [reset]);

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
      <main className={styles.main}>
        <div className={styles.header}>
          <h1 className={styles.title}>Create a Story Video</h1>
          <p className={styles.subtitle}>
            Paste your text, add images, and get a narrated vertical video
            ready for social media
          </p>
        </div>

        <div className={styles.grid}>
          {/* Left Column — Inputs & Settings */}
          <div className={styles.left}>
            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>1. Media & Story</h2>
              <ImageUpload files={files} onFilesChange={setFiles} />
              <PromptInput
                label="Story Text"
                value={storyText}
                onChange={setStoryText}
                placeholder="Paste the text your story should be based on — an article, notes, a chapter… The AI writes the narration and scenes from it."
                maxLength={100000}
                rows={12}
              />
            </div>

            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>2. Generation Settings</h2>
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
                label="Crossfade between scenes"
                description="Blends each scene into the next with a smooth half-second dissolve instead of a hard cut."
                value={crossfade}
                onChange={(checked) => setCrossfade(checked)}
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
            </div>

            <div className={styles.section}>
              <h2 className={styles.sectionTitle}>3. Generate</h2>
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
                <Banner status="error" title="Generation failed" onDismiss={handleReset}>
                  {clip.error}
                </Banner>
              )}

              {/* Page controls — stop a running generation / reset the page */}
              <div className={styles.controlRow}>
                {isGenerating && (
                  <Button
                    variant="secondary"
                    label="⏹ Stop Generation"
                    clickAction={handleStop}
                  />
                )}
                <Button
                  variant="secondary"
                  label="↺ Reset All Settings"
                  clickAction={handleResetAll}
                />
              </div>
            </div>
          </div>

          {/* Right Column — Stage */}
          <div className={styles.right}>
            {clip && clip.status !== "idle" && clip.status !== "script_ready" && (
              <div className={styles.statusBar}>
                <StatusTracker
                  status={clip.status}
                  error={clip.error}
                  statusMessage={clip.statusMessage}
                  currentSegment={clip.currentSegment}
                  totalSegments={clip.totalSegments}
                  enableNarration={clip.enableNarration}
                  enableMusic={clip.enableMusic}
                  onRetry={handleRetry}
                />
                {isInFlight(clip.status) && (
                  <p className={styles.backgroundNote}>
                    You can refresh or close this page — generation keeps
                    running on the server and this page picks it back up.
                  </p>
                )}
              </div>
            )}

            {clip?.status === "complete" && finalVideoUrl ? (
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
            ) : (!clip || clip.status === "idle" || clip.status === "script_ready") && (
              <div className={styles.emptyState}>
                <div style={{ fontSize: "3rem", marginBottom: "0.5rem" }}>🎥</div>
                <h3>Your Studio Awaits</h3>
                <p>Upload media, write your story, and generate magic.</p>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
