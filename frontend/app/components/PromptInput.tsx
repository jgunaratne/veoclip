"use client";

import styles from "./PromptInput.module.css";

interface PromptInputProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  maxLength?: number;
  rows?: number;
}

export default function PromptInput({
  label,
  value,
  onChange,
  placeholder,
  maxLength,
  rows = 4,
}: PromptInputProps) {
  return (
    <div className={styles.wrapper}>
      <label className={styles.label}>{label}</label>
      <div className={styles.textareaWrap}>
        <textarea
          className={styles.textarea}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          maxLength={maxLength}
          rows={rows}
        />
        {maxLength && (
          <span className={styles.count}>
            {value.length} / {maxLength}
          </span>
        )}
      </div>
    </div>
  );
}
