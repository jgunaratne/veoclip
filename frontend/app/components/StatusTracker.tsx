"use client";

import styles from "./StatusTracker.module.css";

type ClipStatus =
  | "idle"
  | "uploading"
  | "preparing_script"
  | "generating_video"
  | "generating_audio"
  | "muxing"
  | "complete"
  | "error";

interface StatusTrackerProps {
  status: ClipStatus;
  error?: string;
  currentSegment?: number;
  totalSegments?: number;
  onRetry?: () => void;
}

const STEPS: { key: ClipStatus; label: string }[] = [
  { key: "preparing_script", label: "Writing Story" },
  { key: "generating_video", label: "Generating Scenes" },
  { key: "generating_audio", label: "Recording Narration" },
  { key: "muxing", label: "Combining" },
  { key: "complete", label: "Complete" },
];

const ORDER: Record<string, number> = {};
STEPS.forEach((s, i) => (ORDER[s.key] = i));

function stepState(
  stepKey: ClipStatus,
  currentStatus: ClipStatus,
): "done" | "active" | "pending" {
  if (currentStatus === "error") return "pending";
  const ci = ORDER[currentStatus] ?? -1;
  const si = ORDER[stepKey] ?? -1;
  if (si < ci) return "done";
  if (si === ci) return "active";
  return "pending";
}

export default function StatusTracker({
  status,
  error,
  currentSegment,
  totalSegments,
  onRetry,
}: StatusTrackerProps) {
  if (status === "idle") return null;

  return (
    <div className={`glass ${styles.tracker}`}>
      {status === "error" ? (
        <div className={styles.errorBox}>
          <span className={styles.errorIcon}>⚠️</span>
          <p className={styles.errorMsg}>{error || "Something went wrong"}</p>
          {onRetry && (
            <button className={styles.retryBtn} onClick={onRetry}>
              ↻ Retry
            </button>
          )}
        </div>
      ) : (
        <div className={styles.steps}>
          {STEPS.map((step, i) => {
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
                    {state === "done" ? "✓" : i + 1}
                  </div>
                  <span className={styles.stepLabel}>{step.label}</span>
                  {state === "active" &&
                    step.key === "generating_video" &&
                    (currentSegment && totalSegments ? (
                      <span className={styles.estimate}>
                        Scene {currentSegment} of {totalSegments} · ~1-4 min each
                      </span>
                    ) : (
                      <span className={styles.estimate}>~1-4 min per scene</span>
                    ))}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
