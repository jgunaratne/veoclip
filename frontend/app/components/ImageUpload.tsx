"use client";

import { useMemo, useRef, useState } from "react";
import { FileInput } from "@astryxdesign/core/FileInput";
import styles from "./ImageUpload.module.css";

const MAX_IMAGES = 8;

interface ImageUploadProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
}

export default function ImageUpload({ files, onFilesChange }: ImageUploadProps) {
  // Recompute previews whenever the files array identity changes (add, remove, OR reorder)
  const previews = useMemo(
    () => files.map((f) => ({ file: f, url: URL.createObjectURL(f) })),
    [files],
  );

  // Drag-and-drop reorder state
  const dragIndexRef = useRef<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  function removeFile(index: number) {
    onFilesChange(files.filter((_, i) => i !== index));
  }

  function handleDragStart(e: React.DragEvent, index: number) {
    dragIndexRef.current = index;
    e.dataTransfer.effectAllowed = "move";
  }

  function handleDragOver(e: React.DragEvent, index: number) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    if (dragIndexRef.current !== null && dragIndexRef.current !== index) {
      setDragOverIndex(index);
    }
  }

  function handleDragLeave() {
    setDragOverIndex(null);
  }

  function handleDrop(e: React.DragEvent, index: number) {
    e.preventDefault();
    const from = dragIndexRef.current;
    if (from === null || from === index) {
      dragIndexRef.current = null;
      setDragOverIndex(null);
      return;
    }

    const reordered = [...files];
    const [moved] = reordered.splice(from, 1);
    reordered.splice(index, 0, moved);
    onFilesChange(reordered);

    dragIndexRef.current = null;
    setDragOverIndex(null);
  }

  function handleDragEnd() {
    dragIndexRef.current = null;
    setDragOverIndex(null);
  }

  return (
    <div className={styles.root}>
      <FileInput
        label="Reference Images"
        value={files}
        onChange={(val) => {
          if (!val) onFilesChange([]);
          else if (Array.isArray(val)) onFilesChange(val);
          else onFilesChange([val]);
        }}
        accept="image/*"
        isMultiple
        mode="dropzone"
        maxFiles={MAX_IMAGES}
        description={`Up to ${MAX_IMAGES} images — drag thumbnails to reorder scenes`}
      />

      {previews.length > 0 && (
        <div className={styles.grid}>
          {previews.map(({ file, url }, i) => (
            <div
              key={`${file.name}-${file.size}-${file.lastModified}-${i}`}
              className={`${styles.thumb} ${dragOverIndex === i ? styles.thumbDropTarget : ""}`}
              draggable
              onDragStart={(e) => handleDragStart(e, i)}
              onDragOver={(e) => handleDragOver(e, i)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, i)}
              onDragEnd={handleDragEnd}
            >
              <div className={styles.orderBadge}>{i + 1}</div>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={url} alt={file.name} className={styles.img} />
              <button
                className={styles.remove}
                onClick={() => removeFile(i)}
                aria-label={`Remove ${file.name}`}
              >
                ✕
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
