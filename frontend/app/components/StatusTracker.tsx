"use client";

import { useState, useEffect, useRef } from "react";
import { Card } from "@astryxdesign/core/Card";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Spinner } from "@astryxdesign/core/Spinner";
import styles from "./StatusTracker.module.css";

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

interface StatusTrackerProps {
  status: ClipStatus;
  error?: string;
  statusMessage?: string;
  currentSegment?: number;
  totalSegments?: number;
  enableNarration?: boolean;
  enableMusic?: boolean;
  onRetry?: () => void;
}

const STEPS: { key: ClipStatus; label: string; icon: string }[] = [
  { key: "preparing_script", label: "Writing Story", icon: "📝" },
  { key: "generating_video", label: "Generating Scenes", icon: "🎬" },
  { key: "generating_audio", label: "Recording Narration", icon: "🎙️" },
  { key: "generating_music", label: "Generating Music", icon: "🎵" },
  { key: "muxing", label: "Combining", icon: "🔗" },
  { key: "complete", label: "Complete", icon: "✅" },
];

const ORDER: Record<string, number> = {
  preparing_script: 0,
  script_ready: 0.5, // Script done, but video not started yet
  generating_video: 1,
  generating_audio: 2,
  generating_music: 3,
  muxing: 4,
  complete: 5,
};

function stepState(
  stepKey: ClipStatus,
  currentStatus: ClipStatus,
): "done" | "active" | "pending" {
  if (currentStatus === "error") return "pending";
  // When fully complete, every step (including the complete step) is done
  if (currentStatus === "complete") return "done";
  const ci = ORDER[currentStatus] ?? -1;
  const si = ORDER[stepKey] ?? -1;
  if (si < ci) return "done";
  if (si === ci) return "active";
  return "pending";
}

/** Returns overall progress 0–100 */
function calcProgress(
  status: ClipStatus,
  currentSegment?: number,
  totalSegments?: number,
): number {
  // Each of the 6 steps is worth ~16.7% of the bar
  const stepIndex = ORDER[status] ?? 0;
  const stepWidth = 100 / STEPS.length;
  const baseProgress = stepIndex * stepWidth;

  if (status === "complete") return 100;

  if (status === "generating_video" && currentSegment && totalSegments) {
    // Sub-progress within the video generation step
    const segFraction = (currentSegment - 1) / totalSegments;
    return baseProgress + segFraction * stepWidth;
  }

  return baseProgress + 2; // small offset so the bar is visible on step entry
}

function useElapsed(status: ClipStatus) {
  const startRef = useRef<number | null>(null);
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (status === "idle") {
      startRef.current = null;
      setElapsed(0);
      return;
    }

    if (
      status !== "complete" &&
      status !== "error" &&
      startRef.current === null
    ) {
      startRef.current = Date.now();
    }

    if (status === "complete" || status === "error") {
      // freeze the timer
      return;
    }

    const id = setInterval(() => {
      if (startRef.current) {
        setElapsed(Math.floor((Date.now() - startRef.current) / 1000));
      }
    }, 1000);

    return () => clearInterval(id);
  }, [status]);

  return elapsed;
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return m > 0 ? `${m}m ${s.toString().padStart(2, "0")}s` : `${s}s`;
}

export default function StatusTracker({
  status,
  error,
  statusMessage,
  currentSegment,
  totalSegments,
  enableNarration,
  enableMusic,
  onRetry,
}: StatusTrackerProps) {
  if (status === "idle") return null;

  // Filter out steps for disabled features
  const visibleSteps = STEPS.filter((step) => {
    if (step.key === "generating_audio" && enableNarration === false) return false;
    if (step.key === "generating_music" && enableMusic === false) return false;
    // Hide muxing when there's nothing to combine (no narration + no music)
    if (step.key === "muxing" && enableNarration === false && enableMusic === false) return false;
    return true;
  });

  const progress = calcProgress(status, currentSegment, totalSegments);
  const elapsed = useElapsed(status);
  const isTerminal = status === "complete" || status === "error";

  return (
    <Card padding={3} className={styles.tracker}>
      {status === "error" ? (
        <div className={styles.errorBox}>
          <Banner status="error" title="Generation failed">
            {error || "Something went wrong"}
          </Banner>
          {onRetry && (
            <Button
              variant="secondary"
              label="↻ Retry"
              clickAction={onRetry}
            />
          )}
        </div>
      ) : (
        <>
          {/* Progress bar */}
          <div className={styles.progressContainer}>
            <div className={styles.progressMeta}>
              <span className={styles.progressPercent}>
                {Math.round(progress)}%
              </span>
              {!isTerminal && (
                <span className={styles.elapsed}>{formatTime(elapsed)}</span>
              )}
            </div>
            <ProgressBar
              value={progress}
              max={100}
              label="Generation progress"
              isLabelHidden
              hasValueLabel={false}
              variant={status === "complete" ? "success" : "accent"}
            />
          </div>

          {/* Transient backend note, e.g. Veo high-demand retry backoff */}
          {statusMessage && !isTerminal && (
            <Banner status="warning" title={statusMessage} />
          )}

          {/* Step indicators */}
          <div className={styles.steps}>
            {visibleSteps.map((step, i) => {
              const state = stepState(step.key, status);
              return (
                <div key={step.key} className={styles.stepGroup}>
                  {i > 0 && (
                    <div
                      className={`${styles.connector} ${state === "pending" ? "" : styles.connectorDone}`}
                    />
                  )}
                  <div className={`${styles.step} ${styles[state]}`}>
                    <div className={styles.dot}>
                      {state === "active" ? (
                        <Spinner size="sm" />
                      ) : state === "done" ? (
                        "✓"
                      ) : (
                        step.icon
                      )}
                    </div>
                    <span className={styles.stepLabel}>{step.label}</span>
                    {state === "active" &&
                      step.key === "generating_video" &&
                      currentSegment &&
                      totalSegments && (
                        <span className={styles.segmentBadge}>
                          {currentSegment}/{totalSegments}
                        </span>
                      )}
                  </div>
                </div>
              );
            })}
          </div>
        </>
      )}
    </Card>
  );
}
