"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@astryxdesign/core/Button";
import VideoPlayer from "../components/VideoPlayer";
import styles from "./page.module.css";

interface VideoEntry {
  id: string;
  title: string;
  mode: "story" | "presenter" | "composite";
  createdAt: string;
  caption?: string;
  url: string;
  filename: string;
  sizeBytes: number;
  length: number;
}

function formatBytes(bytes: number): string {
  if (bytes === 0) return "—";
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function VideosPage() {
  const [videos, setVideos] = useState<VideoEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<VideoEntry | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchVideos = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/videos");
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      const data: VideoEntry[] = await res.json();
      setVideos(data);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchVideos();
  }, [fetchVideos]);

  const handleCopyCaption = (video: VideoEntry) => {
    if (!video.caption) return;
    const text = video.caption;
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      const ta = Object.assign(document.createElement("textarea"), { value: text });
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopiedId(video.id);
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleDelete = useCallback(async (video: VideoEntry) => {
    if (!confirm(`Delete "${video.title}"? This cannot be undone.`)) return;
    setDeletingId(video.id);
    try {
      const res = await fetch(`/api/clips/${video.id}`, { method: "DELETE" });
      if (!res.ok) throw new Error(`Server returned ${res.status}`);
      setVideos((prev) => prev.filter((v) => v.id !== video.id));
      if (selected?.id === video.id) setSelected(null);
    } catch (err) {
      alert(`Failed to delete: ${(err as Error).message}`);
    } finally {
      setDeletingId(null);
    }
  }, [selected]);

  return (
    <main className={styles.main}>
      <div className={styles.header}>
        <div>
          <h1 className={styles.title}>Videos</h1>
          <p className={styles.subtitle}>
            All your generated videos, ready to view and download
          </p>
        </div>
        <Button variant="secondary" label="↻ Refresh" clickAction={fetchVideos} />
      </div>

      {loading && (
        <div className={styles.loadingGrid}>
          {[...Array(4)].map((_, i) => (
            <div key={i} className={styles.skeletonCard} />
          ))}
        </div>
      )}

      {!loading && error && (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>⚠️</div>
          <h2>Could not load videos</h2>
          <p>{error}</p>
          <Button variant="primary" label="Try again" clickAction={fetchVideos} />
        </div>
      )}

      {!loading && !error && videos.length === 0 && (
        <div className={styles.emptyState}>
          <div className={styles.emptyIcon}>🎬</div>
          <h2>No videos yet</h2>
          <p>Generate your first video in Story Mode or Presenter Mode.</p>
        </div>
      )}

      {!loading && !error && videos.length > 0 && (
        <div className={styles.grid}>
          {videos.map((video) => (
            <div
              key={video.id}
              className={`${styles.card} ${selected?.id === video.id ? styles.cardSelected : ""}`}
              onClick={() => setSelected(selected?.id === video.id ? null : video)}
            >
              <div className={styles.cardPreview}>
                {/* eslint-disable-next-line @next/next/no-video-component */}
                <video
                  src={video.url}
                  className={styles.cardVideo}
                  muted
                  preload="metadata"
                />
                <div className={styles.cardOverlay}>
                  <span className={styles.playIcon}>▶</span>
                  <button
                    className={styles.cardDeleteBtn}
                    title="Delete video"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(video);
                    }}
                    disabled={deletingId === video.id}
                  >
                    {deletingId === video.id ? "…" : "🗑"}
                  </button>
                </div>
                <span className={`${styles.modeBadge} ${video.mode === "presenter" ? styles.modeBadgePresenter : styles.modeBadgeStory}`}>
                  {video.mode === "presenter" ? "🎤 Presenter" : video.mode === "composite" ? "🎭 Composite" : "📝 Story"}
                </span>
              </div>

              <div className={styles.cardBody}>
                <p className={styles.cardTitle}>{video.title}</p>
                <div className={styles.cardMeta}>
                  <span>{video.length}s</span>
                  <span>·</span>
                  <span>{formatBytes(video.sizeBytes)}</span>
                  <span>·</span>
                  <span>{formatDate(video.createdAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div className={styles.detail} key={selected.id}>
          <div className={styles.detailClose}>
            <h2 className={styles.detailTitle}>{selected.title}</h2>
            <button className={styles.closeBtn} onClick={() => setSelected(null)}>✕</button>
          </div>

          <VideoPlayer src={selected.url} />

          <div className={styles.detailActions}>
            <a
              href={selected.url}
              download={selected.filename}
              className={styles.downloadBtn}
            >
              ⬇ Download
            </a>
            {selected.caption && (
              <button
                className={styles.copyBtn}
                onClick={() => handleCopyCaption(selected)}
              >
                {copiedId === selected.id ? "✓ Copied!" : "📋 Copy Caption"}
              </button>
            )}
            <button
              className={styles.deleteBtn}
              onClick={() => handleDelete(selected)}
              disabled={deletingId === selected.id}
            >
              {deletingId === selected.id ? "Deleting…" : "🗑 Delete"}
            </button>
          </div>

          {selected.caption && (
            <div className={styles.captionBox}>
              <span className={styles.captionLabel}>TikTok Caption</span>
              <p className={styles.captionText}>{selected.caption}</p>
            </div>
          )}

          <div className={styles.detailMeta}>
            <div className={styles.detailMetaRow}>
              <span>Mode</span>
              <span>{selected.mode === "presenter" ? "🎤 Presenter" : selected.mode === "composite" ? "🎭 Composite" : "📝 Story"}</span>
            </div>
            <div className={styles.detailMetaRow}>
              <span>Length</span>
              <span>{selected.length}s</span>
            </div>
            <div className={styles.detailMetaRow}>
              <span>File size</span>
              <span>{formatBytes(selected.sizeBytes)}</span>
            </div>
            <div className={styles.detailMetaRow}>
              <span>Created</span>
              <span>{formatDate(selected.createdAt)}</span>
            </div>
          </div>
        </div>
      )}
    </main>
  );
}
