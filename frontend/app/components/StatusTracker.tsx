"use client";

import styles from "./StatusTracker.module.css";

type ClipStatus =
  | "idle"
  | "uploading"
  | "generating_video"
  | "generating_audio"
  | "muxing"
  | "complete"
  | "error";

interface StatusTrackerProps {
  status: ClipStatus;
  error?: string;
  onRetry?: () => void;
}

const STEPS: { key: ClipStatus; label: string }[] = [
  { key: "uploading", label: "Uploading" },
  { key: "generating_video", label: "Generating Video" },
  { key: "generating_audio", label: "Generating Audio" },
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
                  {state === "active" && step.key === "generating_video" && (
                    <span className={styles.estimate}>~2-5 min</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
