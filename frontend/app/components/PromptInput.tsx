"use client";

import {TextArea} from '@astryxdesign/core/TextArea';
import styles from './PromptInput.module.css';

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
  rows = 20,
}: PromptInputProps) {
  // Astryx TextArea auto-sizes; enforce a min-height via a wrapper
  // so "rows" translates to a meaningful visual height (~1.5rem per row).
  const minHeight = `${rows * 1.5}rem`;

  return (
    <div className={styles.root} style={{ '--prompt-min-height': minHeight } as React.CSSProperties}>
      <TextArea
        label={label}
        value={value}
        changeAction={(val) => onChange(val)}
        placeholder={placeholder}
        maxLength={maxLength}
      />
    </div>
  );
}
