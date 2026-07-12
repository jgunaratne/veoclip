"use client";

import styles from "./DurationPicker.module.css";

interface DurationPickerProps {
  value: number;
  onChange: (value: number) => void;
}

const OPTIONS = [
  { value: 5, label: "5s" },
  { value: 8, label: "8s" },
  { value: 16, label: "16s", badge: "2×" },
  { value: 24, label: "24s", badge: "3×" },
];

export default function DurationPicker({ value, onChange }: DurationPickerProps) {
  return (
    <div className={styles.wrapper}>
      <label className={styles.label}>Duration</label>
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
