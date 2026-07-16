"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Button } from "@astryxdesign/core/Button";
import { FileInput } from "@astryxdesign/core/FileInput";
import styles from "./page.module.css";

interface ImageEntry {
  filename: string;
  url: string;
  sizeBytes: number;
  createdAt: string;
  usedBy: string[];
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
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function ImagesPage() {
  const [images, setImages] = useState<ImageEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<ImageEntry | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchImages = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/images");
      if (res.ok) setImages(await res.json());
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchImages();
  }, [fetchImages]);

  const handleUpload = useCallback(async () => {
    if (uploadFiles.length === 0) return;
    setUploading(true);
    try {
      const formData = new FormData();
      for (const f of uploadFiles) {
        formData.append("images", f);
      }
      const res = await fetch("/api/images", { method: "POST", body: formData });
      if (res.ok) {
        const newImages: ImageEntry[] = await res.json();
        setImages((prev) => [...newImages, ...prev]);
        setUploadFiles([]);
      }
    } catch {
      /* ignore */
    } finally {
      setUploading(false);
    }
  }, [uploadFiles]);

  const handleDelete = useCallback(
    async (image: ImageEntry) => {
      if (!confirm(`Delete "${image.filename}"? This cannot be undone.`)) return;
      setDeletingId(image.filename);
      try {
        const res = await fetch(`/api/images/${image.filename}`, { method: "DELETE" });
        if (res.ok || res.status === 204) {
          setImages((prev) => prev.filter((i) => i.filename !== image.filename));
          if (selected?.filename === image.filename) setSelected(null);
        }
      } catch {
        /* ignore */
      } finally {
        setDeletingId(null);
      }
    },
    [selected],
  );

  return (
    <main className={styles.main}>
      <div className={styles.header}>
        <div className={styles.headerLeft}>
          <h1 className={styles.title}>Image Assets</h1>
          <p className={styles.subtitle}>
            Manage uploaded images used across your presenter and story clips
          </p>
        </div>
        <div className={styles.headerActions}>
          <Button
            variant="secondary"
            label="↻ Refresh"
            clickAction={fetchImages}
          />
        </div>
      </div>

      {/* Upload section */}
      <div className={styles.uploadSection}>
        <FileInput
          label="Upload Images"
          value={uploadFiles}
          onChange={(val) => {
            if (!val) setUploadFiles([]);
            else if (Array.isArray(val)) setUploadFiles(val);
            else setUploadFiles([val]);
          }}
          accept="image/*"
          mode="dropzone"
          maxFiles={8}
          description="Drag & drop images here, or click to browse (up to 8 at a time)"
          ref={fileInputRef}
        />
        {uploadFiles.length > 0 && (
          <div style={{ marginTop: "0.75rem", display: "flex", gap: "0.75rem" }}>
            <Button
              variant="primary"
              label={uploading ? "Uploading…" : `⬆ Upload ${uploadFiles.length} image${uploadFiles.length > 1 ? "s" : ""}`}
              isDisabled={uploading}
              clickAction={handleUpload}
            />
            <Button
              variant="secondary"
              label="Cancel"
              clickAction={() => setUploadFiles([])}
            />
          </div>
        )}
      </div>

      {/* Loading skeleton */}
      {loading && images.length === 0 && (
        <div className={styles.loadingGrid}>
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className={styles.skeletonCard} />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && images.length === 0 && (
        <div className={styles.emptyState}>
          <span className={styles.emptyIcon}>🖼️</span>
          <h2>No images yet</h2>
          <p>Upload images above to use them in your presenter and story clips.</p>
        </div>
      )}

      {/* Image grid */}
      {images.length > 0 && (
        <div className={styles.grid}>
          {images.map((image) => (
            <div
              key={image.filename}
              className={`${styles.card} ${selected?.filename === image.filename ? styles.cardSelected : ""}`}
              onClick={() =>
                setSelected(selected?.filename === image.filename ? null : image)
              }
            >
              <div className={styles.cardPreview}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={image.url}
                  alt={image.filename}
                  className={styles.cardImage}
                  loading="lazy"
                />
                <div className={styles.cardOverlay}>
                  <button
                    className={styles.cardDeleteBtn}
                    title="Delete image"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDelete(image);
                    }}
                    disabled={deletingId === image.filename}
                  >
                    {deletingId === image.filename ? "…" : "🗑"}
                  </button>
                </div>
                {image.usedBy.length > 0 && (
                  <span className={styles.usageBadge}>
                    {image.usedBy.length} clip{image.usedBy.length > 1 ? "s" : ""}
                  </span>
                )}
              </div>
              <div className={styles.cardBody}>
                <p className={styles.cardFilename} title={image.filename}>
                  {image.filename}
                </p>
                <div className={styles.cardMeta}>
                  <span>{formatBytes(image.sizeBytes)}</span>
                  <span>·</span>
                  <span>{formatDate(image.createdAt)}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Detail panel */}
      {selected && (
        <div className={styles.detail}>
          <div className={styles.detailClose}>
            <h3 className={styles.detailTitle}>{selected.filename}</h3>
            <button
              className={styles.closeBtn}
              onClick={() => setSelected(null)}
            >
              ✕
            </button>
          </div>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={selected.url}
            alt={selected.filename}
            className={styles.detailImage}
          />

          <div className={styles.detailActions}>
            <a
              href={selected.url}
              download={selected.filename}
              className={styles.downloadBtn}
            >
              ⬇ Download
            </a>
            <button
              className={styles.deleteBtn}
              onClick={() => handleDelete(selected)}
              disabled={deletingId === selected.filename}
            >
              {deletingId === selected.filename ? "Deleting…" : "🗑 Delete"}
            </button>
          </div>

          <div className={styles.detailMeta}>
            <div className={styles.detailMetaRow}>
              <span>Size</span>
              <span>{formatBytes(selected.sizeBytes)}</span>
            </div>
            <div className={styles.detailMetaRow}>
              <span>Uploaded</span>
              <span>{formatDate(selected.createdAt)}</span>
            </div>
            {selected.usedBy.length > 0 && (
              <div className={styles.detailMetaRow}>
                <span>Used by</span>
                <div className={styles.usageList}>
                  {selected.usedBy.map((title, i) => (
                    <span key={i} className={styles.usageTag}>
                      {title}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </main>
  );
}
