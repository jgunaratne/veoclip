"use client";

import { useState, useCallback, useEffect } from "react";
import { Button } from "@astryxdesign/core/Button";
import { Banner } from "@astryxdesign/core/Banner";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { FileInput } from "@astryxdesign/core/FileInput";

import { useClipTracker, isInFlight } from "../hooks/useClipTracker";
import PromptInput from "../components/PromptInput";
import DurationPicker from "../components/DurationPicker";
import PersonalityPicker from "../components/PersonalityPicker";
import type { PresenterPersonality } from "../components/PersonalityPicker";
import StylePicker from "../components/StylePicker";
import type { PresenterStyle } from "../components/StylePicker";
import VoicePicker, { DEFAULT_VOICE_OPTIONS } from "../components/VoicePicker";
import type { VoiceOptions } from "../components/VoicePicker";
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
  mode?: "story" | "presenter";
  // Inputs echoed back by the backend — used to restore the form on resume
  storyText?: string;
  referenceImagePaths?: string[];
  length?: number;
  ensureContinuity?: boolean;
  crossfade?: boolean;
  bookendImage?: boolean;
  presenterPersonality?: PresenterPersonality;
  presenterStyle?: PresenterStyle;
  voiceAge?: VoiceOptions["age"];
  voicePitch?: VoiceOptions["pitch"];
  voiceTexture?: VoiceOptions["texture"];
  voiceAccent?: VoiceOptions["accent"];
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

interface PreviousPhoto {
  url: string;
  path: string;
  clipTitle: string;
  createdAt: string;
}

export default function PresenterModePage() {
  // Form state
  const [faceFile, setFaceFile] = useState<File | null>(null);
  const [selectedPhoto, setSelectedPhoto] = useState<PreviousPhoto | null>(null);
  const [previousPhotos, setPreviousPhotos] = useState<PreviousPhoto[]>([]);
  const [deletingPhotoUrl, setDeletingPhotoUrl] = useState<string | null>(null);
  const [storyText, setStoryText] = useState("");
  const [length, setLength] = useState(30);
  const [personality, setPersonality] = useState<PresenterPersonality>("social");
  const [scriptStyle, setScriptStyle] = useState<PresenterStyle>("social_media");
  const [crossfade, setCrossfade] = useState(false);
  const [ensureContinuity, setEnsureContinuity] = useState(false);
  const [bookendImage, setBookendImage] = useState(true);
  const [voiceOptions, setVoiceOptions] = useState<VoiceOptions>(DEFAULT_VOICE_OPTIONS);

  // Generation state — the tracker persists the active clip ID in
  // localStorage and reattaches to the still-running backend pipeline after
  // a page refresh or a closed browser tab.
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [editedNarration, setEditedNarration] = useState("");

  const { clip, setClip, remember, watch, reset } = useClipTracker<Clip>(
    "veoclip.activeClip.presenter",
    (recovered) => {
      // Restore the form so the user can edit/retry after a reload
      if (recovered.storyText) setStoryText(recovered.storyText);
      if (recovered.length) setLength(recovered.length);
      if (recovered.presenterPersonality) setPersonality(recovered.presenterPersonality);
      if (recovered.presenterStyle) setScriptStyle(recovered.presenterStyle);
      if (recovered.ensureContinuity !== undefined) setEnsureContinuity(recovered.ensureContinuity);
      if (recovered.crossfade !== undefined) setCrossfade(recovered.crossfade);
      if (recovered.bookendImage !== undefined) setBookendImage(recovered.bookendImage);
      const facePath = recovered.referenceImagePaths?.[0];
      if (facePath) {
        setSelectedPhoto({
          url: `/uploads/${facePath.split("/").pop()}`,
          path: facePath,
          clipTitle: "",
          createdAt: "",
        });
      }
      setVoiceOptions({
        age: recovered.voiceAge ?? DEFAULT_VOICE_OPTIONS.age,
        pitch: recovered.voicePitch ?? DEFAULT_VOICE_OPTIONS.pitch,
        texture: recovered.voiceTexture ?? DEFAULT_VOICE_OPTIONS.texture,
        accent: recovered.voiceAccent ?? DEFAULT_VOICE_OPTIONS.accent,
      });
      setEditedNarration(recovered.narrationScript ?? "");
    },
  );

  useEffect(() => {
    // Load previously used presenter photos
    fetch("/api/presenter-photos")
      .then(async (res) => {
        if (res.ok) setPreviousPhotos(await res.json());
      })
      .catch(() => {});
  }, []);

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
      const formData = new FormData();
      if (faceFile) {
        formData.append("images", faceFile);
      } else if (selectedPhoto) {
        formData.append("existingImagePath", selectedPhoto.path);
      }
      formData.append("storyText", storyText);
      formData.append("speakerVoice", "Puck");
      formData.append("length", String(length));
      formData.append("ensureContinuity", String(ensureContinuity));
      formData.append("enableMusic", "false");
      formData.append("enableNarration", "false"); // Speech is in the Veo video directly
      formData.append("mode", "presenter");
      formData.append("presenterPersonality", personality);
      formData.append("presenterStyle", scriptStyle);
      formData.append("crossfade", String(crossfade));
      formData.append("bookendImage", String(bookendImage));
      formData.append("voiceAge", voiceOptions.age);
      formData.append("voicePitch", voiceOptions.pitch);
      formData.append("voiceTexture", voiceOptions.texture);
      formData.append("voiceAccent", voiceOptions.accent);

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
  }, [faceFile, selectedPhoto, storyText, length, personality, scriptStyle, crossfade, ensureContinuity, bookendImage, voiceOptions, remember, setClip]);

  const handleGenerateVideo = useCallback(async () => {
    if (!clip || clip.status !== "script_ready") return;
    setIsSubmitting(true);

    try {
      const genRes = await fetch(`/api/clips/${clip.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          narrationScript: editedNarration,
          crossfade,
          ensureContinuity,
          bookendImage,
          voiceAge: voiceOptions.age,
          voicePitch: voiceOptions.pitch,
          voiceTexture: voiceOptions.texture,
          voiceAccent: voiceOptions.accent,
        }),
      });

      if (!genRes.ok) {
        const errorMsg = await getErrorMessage(genRes);
        throw new Error(errorMsg);
      }

      setClip((prev) => prev ? { ...prev, status: "generating_video" } : prev);

      // Track live status (SSE with polling fallback, refresh-proof)
      watch(clip.id);
    } catch (err) {
      setClip((prev) =>
        prev
          ? { ...prev, status: "error", error: (err as Error).message }
          : { id: "", status: "error", error: (err as Error).message },
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [clip, editedNarration, crossfade, ensureContinuity, bookendImage, voiceOptions, watch, setClip]);

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
            crossfade,
            ensureContinuity,
            bookendImage,
            voiceAge: voiceOptions.age,
            voicePitch: voiceOptions.pitch,
            voiceTexture: voiceOptions.texture,
            voiceAccent: voiceOptions.accent,
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
  }, [clip, editedNarration, crossfade, ensureContinuity, bookendImage, voiceOptions, watch, reset, setClip, handleGenerateScript]);

  // Clear the tracked clip (and any error) without touching the form.
  const handleReset = useCallback(() => {
    reset();
    setEditedNarration("");
  }, [reset]);

  // Re-generate the video from the same script. This creates a brand-new
  // generation run so the user can try again if the first result wasn't good.
  const handleRegenerateVideo = useCallback(async () => {
    if (!clip?.id) return;
    setIsSubmitting(true);
    try {
      const res = await fetch(`/api/clips/${clip.id}/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          narrationScript: editedNarration || clip.narrationScript,
          crossfade,
          ensureContinuity,
          bookendImage,
          voiceAge: voiceOptions.age,
          voicePitch: voiceOptions.pitch,
          voiceTexture: voiceOptions.texture,
          voiceAccent: voiceOptions.accent,
        }),
      });
      if (!res.ok) throw new Error(await getErrorMessage(res));
      setClip((prev) =>
        prev ? { ...prev, status: "generating_video", error: undefined, finalPath: undefined, videoPath: undefined } : prev,
      );
      watch(clip.id);
    } catch (err) {
      setClip((prev) =>
        prev ? { ...prev, status: "error", error: (err as Error).message } : prev,
      );
    } finally {
      setIsSubmitting(false);
    }
  }, [clip, editedNarration, crossfade, ensureContinuity, bookendImage, voiceOptions, watch, setClip]);

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
    setFaceFile(null);
    setSelectedPhoto(null);
    setStoryText("");
    setLength(30);
    setPersonality("social");
    setScriptStyle("social_media");
    setCrossfade(false);
    setEnsureContinuity(false);
    setBookendImage(true);
    setVoiceOptions(DEFAULT_VOICE_OPTIONS);
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

  const finalVideoUrl = clip?.finalPath
    ? `/media/${clip.finalPath.split("/").pop()}`
    : clip?.videoPath
      ? `/media/${clip.videoPath.split("/").pop()}`
      : null;

  const showRightColumn = clip && clip.status !== "idle";

  // Face image preview: new upload takes priority, then selected previous photo
  const facePreviewUrl = faceFile
    ? URL.createObjectURL(faceFile)
    : selectedPhoto
      ? selectedPhoto.url
      : null;

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
              {previousPhotos.length > 0 && (
                <div>
                  <label className={styles.photoPickerLabel}>Previous Photos</label>
                  <div className={styles.photoGrid}>
                    {previousPhotos.map((photo) => {
                      const filename = photo.url.split("/").pop()!;
                      return (
                      <div key={photo.url} className={styles.photoThumbWrap}>
                        <button
                          type="button"
                          className={`${styles.photoThumb} ${
                            selectedPhoto?.url === photo.url && !faceFile
                              ? styles.photoThumbActive
                              : ""
                          }`}
                          onClick={() => {
                            if (selectedPhoto?.url === photo.url) {
                              setSelectedPhoto(null);
                            } else {
                              setSelectedPhoto(photo);
                              setFaceFile(null);
                            }
                          }}
                          title={photo.clipTitle}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={photo.url}
                            alt={photo.clipTitle}
                            className={styles.photoThumbImg}
                          />
                        </button>
                        <button
                          type="button"
                          className={styles.photoDeleteBtn}
                          title="Delete photo"
                          disabled={deletingPhotoUrl === photo.url}
                          onClick={async (e) => {
                            e.stopPropagation();
                            if (!confirm("Delete this photo?")) return;
                            setDeletingPhotoUrl(photo.url);
                            try {
                              const res = await fetch(`/api/images/${filename}`, { method: "DELETE" });
                              if (res.ok || res.status === 204) {
                                setPreviousPhotos((prev) => prev.filter((p) => p.url !== photo.url));
                                if (selectedPhoto?.url === photo.url) setSelectedPhoto(null);
                              }
                            } catch { /* ignore */ }
                            setDeletingPhotoUrl(null);
                          }}
                        >
                          {deletingPhotoUrl === photo.url ? "…" : "✕"}
                        </button>
                      </div>
                      );
                    })}
                  </div>
                </div>
              )}

              <FileInput
                label={previousPhotos.length > 0 ? "…or upload a new photo" : "Face Photo"}
                value={faceFile ? [faceFile] : []}
                onChange={(val) => {
                  const file = !val
                    ? null
                    : Array.isArray(val)
                      ? val[0] ?? null
                      : val;
                  setFaceFile(file);
                  // Only clear selectedPhoto when a real file was picked
                  if (file) setSelectedPhoto(null);
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
                    onClick={() => {
                      setFaceFile(null);
                      setSelectedPhoto(null);
                    }}
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
              <h2 className={styles.sectionTitle}>2. Style & Settings</h2>
              <StylePicker value={scriptStyle} onChange={setScriptStyle} />
              <PersonalityPicker value={personality} onChange={setPersonality} />
              <VoicePicker value={voiceOptions} onChange={setVoiceOptions} />
              <div className={styles.settings}>
                <DurationPicker value={length} onChange={setLength} />
              </div>
              <CheckboxInput
                label="Continuity between clips"
                description="Each clip continues from the last frame of the previous one, so pose and motion flow across cuts. The face photo then only seeds the first clip, so likeness may drift slightly on longer videos."
                value={ensureContinuity}
                onChange={(checked) => setEnsureContinuity(checked)}
              />
              <CheckboxInput
                label="Crossfade between cuts"
                description="Blends each 8-second take into the next with a smooth half-second dissolve instead of a hard cut."
                value={crossfade}
                onChange={(checked) => setCrossfade(checked)}
              />
              <CheckboxInput
                label="Seamless cuts (start & end each clip on your photo)"
                description="Every 8-second clip begins and ends exactly on the presenter photo, so the frames on both sides of each cut match and the stitched video looks like fewer cuts. Needs a face photo."
                value={bookendImage}
                onChange={(checked) => setBookendImage(checked)}
              />
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
                <>
                  <Button
                    variant="primary"
                    size="lg"
                    label={isSubmitting ? "Submitting…" : "🎬 Generate Video"}
                    isDisabled={!canGenerateVideo}
                    clickAction={handleGenerateVideo}
                  />
                  {/* Not happy with the script? Write a fresh one from the
                      same story text and settings. */}
                  <Button
                    variant="secondary"
                    label={isSubmitting ? "Submitting…" : "↻ Regenerate Script"}
                    isDisabled={!storyText.trim() || isSubmitting}
                    clickAction={handleGenerateScript}
                  />
                </>
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
                  onDismiss={handleReset}
                >
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
                  enableNarration={false}
                  enableMusic={false}
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
                <div className={styles.resultActions}>
                  <a
                    href={finalVideoUrl}
                    download={`veoclip_presenter_${clip.id}.mp4`}
                    className={`btn-primary ${styles.downloadBtn}`}
                  >
                    <span>⬇ Download Video</span>
                  </a>
                  <Button
                    variant="secondary"
                    label={isSubmitting ? "Submitting…" : "🔄 Regenerate Video"}
                    isDisabled={isSubmitting}
                    clickAction={handleRegenerateVideo}
                  />
                </div>

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
                        const text = clip.caption!;
                        if (navigator.clipboard?.writeText) {
                          navigator.clipboard.writeText(text);
                        } else {
                          const ta = Object.assign(document.createElement("textarea"), { value: text });
                          document.body.appendChild(ta);
                          ta.select();
                          document.execCommand("copy");
                          document.body.removeChild(ta);
                        }
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
