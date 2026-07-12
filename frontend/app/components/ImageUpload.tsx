"use client";

import { useRef, useState, useCallback, useEffect, useMemo } from "react";
import styles from "./ImageUpload.module.css";

const MAX_IMAGES = 8;

interface ImageUploadProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
}

export default function ImageUpload({ files, onFilesChange }: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  // Object URLs derived from the file list; revoked when the list changes
  const previews = useMemo(
    () => files.map((f) => URL.createObjectURL(f)),
    [files],
  );
  useEffect(() => {
    return () => previews.forEach((u) => URL.revokeObjectURL(u));
  }, [previews]);

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const images = Array.from(incoming).filter((f) =>
        f.type.startsWith("image/"),
      );
      if (images.length === 0) return;
      onFilesChange([...files, ...images].slice(0, MAX_IMAGES));
    },
    [files, onFilesChange],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) addFiles(e.target.files);
      e.target.value = "";
    },
    [addFiles],
  );

  const handleRemove = useCallback(
    (index: number) => {
      onFilesChange(files.filter((_, i) => i !== index));
    },
    [files, onFilesChange],
  );

  return (
    <div
      className={`glass ${styles.dropzone} ${dragOver ? styles.dragOver : ""} ${files.length > 0 ? styles.hasFile : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => files.length === 0 && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        multiple
        onChange={handleInputChange}
        className={styles.fileInput}
      />

      {files.length > 0 ? (
        <div className={styles.grid}>
          {files.map((file, i) => (
            <div key={`${file.name}-${i}`} className={styles.thumbWrap}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={previews[i]} alt={file.name} className={styles.thumb} />
              <span className={styles.thumbIndex}>{i + 1}</span>
              <button
                className={styles.thumbRemove}
                onClick={(e) => {
                  e.stopPropagation();
                  handleRemove(i);
                }}
                aria-label={`Remove image ${i + 1}`}
              >
                ✕
              </button>
            </div>
          ))}
          {files.length < MAX_IMAGES && (
            <button
              className={styles.addTile}
              onClick={(e) => {
                e.stopPropagation();
                inputRef.current?.click();
              }}
            >
              <span className={styles.addIcon}>＋</span>
              <span>Add</span>
            </button>
          )}
        </div>
      ) : (
        <div className={styles.placeholder}>
          <span className={styles.icon}>📸</span>
          <p className={styles.label}>
            Drop images here or <span className={styles.browse}>browse</span>
          </p>
          <p className={styles.hint}>
            Up to {MAX_IMAGES} images — they&apos;ll anchor scenes across your story
          </p>
        </div>
      )}
    </div>
  );
}
