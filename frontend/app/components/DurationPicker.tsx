"use client";

import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';
import styles from './DurationPicker.module.css';

interface DurationPickerProps {
  value: number;
  onChange: (value: number) => void;
}

// Story length in seconds → segment count → max useful images
const OPTIONS = [
  { value: 30, label: "30s", scenes: 4, maxImages: 4 },
  { value: 60, label: "1 min", scenes: 8, maxImages: 8 },
  { value: 180, label: "3 min", scenes: 23, maxImages: 8 },
];

export default function DurationPicker({ value, onChange }: DurationPickerProps) {
  const selected = OPTIONS.find((o) => o.value === value) ?? OPTIONS[0];

  return (
    <div className={styles.root}>
      <SegmentedControl
        label="Video duration"
        value={String(value)}
        onChange={(v) => onChange(Number(v))}
      >
        {OPTIONS.map((opt) => (
          <SegmentedControlItem key={opt.value} value={String(opt.value)} label={opt.label} />
        ))}
      </SegmentedControl>
      <p className={styles.hint}>
        {selected.scenes} scenes · up to {selected.maxImages} images
      </p>
    </div>
  );
}
