"use client";

import { useMemo } from "react";
import { FileInput } from "@astryxdesign/core/FileInput";
import styles from "./ImageUpload.module.css";

const MAX_IMAGES = 8;

interface ImageUploadProps {
  files: File[];
  onFilesChange: (files: File[]) => void;
}

export default function ImageUpload({ files, onFilesChange }: ImageUploadProps) {
  // Create stable object URLs for preview thumbnails
  const previews = useMemo(
    () => files.map((f) => ({ file: f, url: URL.createObjectURL(f) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [files.length],
  );

  function removeFile(index: number) {
    onFilesChange(files.filter((_, i) => i !== index));
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
        description={`Up to ${MAX_IMAGES} images — each anchors a scene in your video`}
      />

      {previews.length > 0 && (
        <div className={styles.grid}>
          {previews.map(({ file, url }, i) => (
            <div key={url} className={styles.thumb}>
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
