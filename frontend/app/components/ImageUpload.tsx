"use client";

import { useRef, useState, useCallback } from "react";
import styles from "./ImageUpload.module.css";

interface ImageUploadProps {
  file: File | null;
  onFileChange: (file: File | null) => void;
}

export default function ImageUpload({ file, onFileChange }: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [preview, setPreview] = useState<string | null>(null);

  const handleFile = useCallback(
    (f: File) => {
      onFileChange(f);
      const url = URL.createObjectURL(f);
      setPreview(url);
    },
    [onFileChange],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith("image/")) handleFile(f);
    },
    [handleFile],
  );

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const f = e.target.files?.[0];
      if (f) handleFile(f);
    },
    [handleFile],
  );

  const handleRemove = useCallback(() => {
    onFileChange(null);
    if (preview) URL.revokeObjectURL(preview);
    setPreview(null);
    if (inputRef.current) inputRef.current.value = "";
  }, [onFileChange, preview]);

  const formatSize = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  };

  return (
    <div
      className={`glass ${styles.dropzone} ${dragOver ? styles.dragOver : ""} ${file ? styles.hasFile : ""}`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !file && inputRef.current?.click()}
    >
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        onChange={handleInputChange}
        className={styles.fileInput}
      />

      {file && preview ? (
        <div className={styles.previewWrap}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={preview} alt="Preview" className={styles.preview} />
          <div className={styles.overlay}>
            <button className={styles.removeBtn} onClick={handleRemove}>
              ✕ Remove
            </button>
            <span className={styles.fileSize}>{formatSize(file.size)}</span>
          </div>
        </div>
      ) : (
        <div className={styles.placeholder}>
          <span className={styles.icon}>📸</span>
          <p className={styles.label}>
            Drop an image here or <span className={styles.browse}>browse</span>
          </p>
          <p className={styles.hint}>PNG, JPG, WebP — up to 25 MB</p>
        </div>
      )}
    </div>
  );
}
