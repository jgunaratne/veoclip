"use client";

import styles from "./DurationPicker.module.css";

interface DurationPickerProps {
  value: number;
  onChange: (value: number) => void;
}

// Story length in seconds → generated as chained 8 s Veo segments
const OPTIONS = [
  { value: 30, label: "30s", badge: "4 scenes" },
  { value: 60, label: "1m", badge: "8 scenes" },
  { value: 180, label: "3m", badge: "23 scenes" },
];

export default function DurationPicker({ value, onChange }: DurationPickerProps) {
  return (
    <div className={styles.wrapper}>
      <label className={styles.label}>Story Length</label>
      <div className={styles.pills}>
        {OPTIONS.map((opt) => (
          <button
            key={opt.value}
            type="button"
            className={`${styles.pill} ${value === opt.value ? styles.active : ""}`}
            onClick={() => onChange(opt.value)}
          >
            {opt.label}
            {opt.badge && <span className={styles.badge}>{opt.badge}</span>}
          </button>
        ))}
      </div>
    </div>
  );
}
