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
  const [selectedSet, setSelectedSet] = useState<Set<string>>(new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(new Set());
  const [uploading, setUploading] = useState(false);
  const [uploadFiles, setUploadFiles] = useState<File[]>([]);
  const lastClickedIndex = useRef<number | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Marquee (drag rectangle) selection state
  const [marqueeRect, setMarqueeRect] = useState<{
    left: number;
    top: number;
    width: number;
    height: number;
  } | null>(null);
  const marqueeStart = useRef<{ pageX: number; pageY: number } | null>(null);
  const marqueeBase = useRef<Set<string>>(new Set());
  const marqueeAdditive = useRef(false);
  const didMarquee = useRef(false);
  const cardRefs = useRef(new Map<string, HTMLDivElement | null>());

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

  // Drag a rectangle over the grid to select the images it touches.
  // Plain drags replace the selection; shift/cmd/ctrl drags add to it.
  // A real marquee only starts after a few px of movement so ordinary
  // clicks keep working.
  const handleGridMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (e.button !== 0) return;
      // Stop native image dragging / text selection from fighting the marquee
      e.preventDefault();

      marqueeStart.current = { pageX: e.pageX, pageY: e.pageY };
      marqueeAdditive.current = e.shiftKey || e.metaKey || e.ctrlKey;
      marqueeBase.current = new Set(selectedSet);
      didMarquee.current = false;

      const handleMove = (ev: MouseEvent) => {
        const start = marqueeStart.current;
        if (!start) return;
        const dx = ev.pageX - start.pageX;
        const dy = ev.pageY - start.pageY;
        if (!didMarquee.current && Math.abs(dx) < 5 && Math.abs(dy) < 5) return;
        didMarquee.current = true;

        // Anchor lives in page coords so scrolling mid-drag stays correct;
        // convert to viewport coords for rendering and hit testing
        const left = Math.min(start.pageX, ev.pageX) - window.scrollX;
        const top = Math.min(start.pageY, ev.pageY) - window.scrollY;
        const width = Math.abs(dx);
        const height = Math.abs(dy);
        setMarqueeRect({ left, top, width, height });

        const hits = new Set(marqueeAdditive.current ? marqueeBase.current : []);
        for (const [filename, el] of cardRefs.current) {
          if (!el) continue;
          const r = el.getBoundingClientRect();
          const overlaps =
            r.left < left + width && r.right > left && r.top < top + height && r.bottom > top;
          if (overlaps) hits.add(filename);
        }
        setSelectedSet(hits);
      };

      const handleUp = () => {
        marqueeStart.current = null;
        setMarqueeRect(null);
        window.removeEventListener("mousemove", handleMove);
        window.removeEventListener("mouseup", handleUp);
        // The click event fires right after mouseup — clear the flag on the
        // next tick so that click knows it followed a drag
        setTimeout(() => {
          didMarquee.current = false;
        }, 0);
      };

      window.addEventListener("mousemove", handleMove);
      window.addEventListener("mouseup", handleUp);
    },
    [selectedSet],
  );

  // Click handler with shift-select support
  const handleCardClick = useCallback(
    (index: number, e: React.MouseEvent) => {
      // Ignore the click that ends a marquee drag
      if (didMarquee.current) return;

      const filename = images[index].filename;

      if (e.shiftKey && lastClickedIndex.current !== null) {
        // Shift+click: select range from last clicked to current
        const start = Math.min(lastClickedIndex.current, index);
        const end = Math.max(lastClickedIndex.current, index);
        setSelectedSet((prev) => {
          const next = new Set(prev);
          for (let i = start; i <= end; i++) {
            next.add(images[i].filename);
          }
          return next;
        });
      } else if (e.metaKey || e.ctrlKey) {
        // Cmd/Ctrl+click: toggle individual item
        setSelectedSet((prev) => {
          const next = new Set(prev);
          if (next.has(filename)) {
            next.delete(filename);
          } else {
            next.add(filename);
          }
          return next;
        });
      } else {
        // Plain click: select only this item (or deselect if already sole selection)
        setSelectedSet((prev) => {
          if (prev.size === 1 && prev.has(filename)) {
            return new Set();
          }
          return new Set([filename]);
        });
      }

      lastClickedIndex.current = index;
    },
    [images],
  );

  const handleDeleteOne = useCallback(
    async (image: ImageEntry) => {
      if (!confirm(`Delete "${image.filename}"? This cannot be undone.`)) return;
      setDeletingIds((prev) => new Set(prev).add(image.filename));
      try {
        const res = await fetch(`/api/images/${image.filename}`, { method: "DELETE" });
        if (res.ok || res.status === 204) {
          setImages((prev) => prev.filter((i) => i.filename !== image.filename));
          setSelectedSet((prev) => {
            const next = new Set(prev);
            next.delete(image.filename);
            return next;
          });
        }
      } catch {
        /* ignore */
      } finally {
        setDeletingIds((prev) => {
          const next = new Set(prev);
          next.delete(image.filename);
          return next;
        });
      }
    },
    [],
  );

  const handleBulkDelete = useCallback(async () => {
    const count = selectedSet.size;
    if (count === 0) return;
    if (!confirm(`Delete ${count} image${count > 1 ? "s" : ""}? This cannot be undone.`)) return;

    const toDelete = [...selectedSet];
    setDeletingIds(new Set(toDelete));

    const deleted: string[] = [];
    for (const filename of toDelete) {
      try {
        const res = await fetch(`/api/images/${filename}`, { method: "DELETE" });
        if (res.ok || res.status === 204) deleted.push(filename);
      } catch {
        /* ignore */
      }
    }

    setImages((prev) => prev.filter((i) => !deleted.includes(i.filename)));
    setSelectedSet(new Set());
    setDeletingIds(new Set());
  }, [selectedSet]);

  const handleSelectAll = useCallback(() => {
    if (selectedSet.size === images.length) {
      setSelectedSet(new Set());
    } else {
      setSelectedSet(new Set(images.map((i) => i.filename)));
    }
  }, [images, selectedSet]);

  // Derived state
  const selectedImages = images.filter((i) => selectedSet.has(i.filename));
  const singleSelected = selectedImages.length === 1 ? selectedImages[0] : null;
  const isBulkDeleting = deletingIds.size > 0;

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

      {/* Bulk action bar */}
      {selectedSet.size > 0 && (
        <div className={styles.bulkBar}>
          <span className={styles.bulkCount}>
            {selectedSet.size} selected
          </span>
          <div className={styles.bulkActions}>
            <button
              className={styles.bulkSelectAll}
              onClick={handleSelectAll}
            >
              {selectedSet.size === images.length ? "Deselect All" : "Select All"}
            </button>
            <button
              className={styles.bulkDeselect}
              onClick={() => setSelectedSet(new Set())}
            >
              Clear
            </button>
            <button
              className={styles.bulkDeleteBtn}
              onClick={handleBulkDelete}
              disabled={isBulkDeleting}
            >
              {isBulkDeleting ? "Deleting…" : `🗑 Delete ${selectedSet.size}`}
            </button>
          </div>
        </div>
      )}

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

      {/* Image grid — drag on it to rubber-band-select */}
      {images.length > 0 && (
        <div className={styles.grid} onMouseDown={handleGridMouseDown}>
          {images.map((image, index) => (
            <div
              key={image.filename}
              ref={(el) => {
                cardRefs.current.set(image.filename, el);
              }}
              className={`${styles.card} ${selectedSet.has(image.filename) ? styles.cardSelected : ""}`}
              onClick={(e) => handleCardClick(index, e)}
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
                      handleDeleteOne(image);
                    }}
                    disabled={deletingIds.has(image.filename)}
                  >
                    {deletingIds.has(image.filename) ? "…" : "🗑"}
                  </button>
                </div>
                {/* Selection checkbox indicator */}
                {selectedSet.size > 0 && (
                  <span className={`${styles.selectIndicator} ${selectedSet.has(image.filename) ? styles.selectIndicatorActive : ""}`}>
                    {selectedSet.has(image.filename) ? "✓" : ""}
                  </span>
                )}
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

      {/* Marquee selection rectangle */}
      {marqueeRect && (
        <div
          className={styles.marquee}
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
          }}
        />
      )}

      {/* Detail panel — single selection only */}
      {singleSelected && (
        <div className={styles.detail}>
          <div className={styles.detailClose}>
            <h3 className={styles.detailTitle}>{singleSelected.filename}</h3>
            <button
              className={styles.closeBtn}
              onClick={() => setSelectedSet(new Set())}
            >
              ✕
            </button>
          </div>

          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={singleSelected.url}
            alt={singleSelected.filename}
            className={styles.detailImage}
          />

          <div className={styles.detailActions}>
            <a
              href={singleSelected.url}
              download={singleSelected.filename}
              className={styles.downloadBtn}
            >
              ⬇ Download
            </a>
            <button
              className={styles.deleteBtn}
              onClick={() => handleDeleteOne(singleSelected)}
              disabled={deletingIds.has(singleSelected.filename)}
            >
              {deletingIds.has(singleSelected.filename) ? "Deleting…" : "🗑 Delete"}
            </button>
          </div>

          <div className={styles.detailMeta}>
            <div className={styles.detailMetaRow}>
              <span>Size</span>
              <span>{formatBytes(singleSelected.sizeBytes)}</span>
            </div>
            <div className={styles.detailMetaRow}>
              <span>Uploaded</span>
              <span>{formatDate(singleSelected.createdAt)}</span>
            </div>
            {singleSelected.usedBy.length > 0 && (
              <div className={styles.detailMetaRow}>
                <span>Used by</span>
                <div className={styles.usageList}>
                  {singleSelected.usedBy.map((title, i) => (
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
