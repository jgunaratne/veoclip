"use client";

import styles from "./VoicePicker.module.css";

export type VoiceAge = "default" | "gen_z" | "millennial" | "gen_x" | "mature";
export type VoicePitch = "default" | "very_low" | "low" | "high" | "very_high";
export type VoiceTexture = "default" | "raspy" | "breathy" | "husky" | "bright";

export interface VoiceOptions {
  age: VoiceAge;
  pitch: VoicePitch;
  texture: VoiceTexture;
}

export const DEFAULT_VOICE_OPTIONS: VoiceOptions = {
  age: "default",
  pitch: "default",
  texture: "default",
};

const AGE_OPTIONS: { value: VoiceAge; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "gen_z", label: "Gen Z" },
  { value: "millennial", label: "Millennial" },
  { value: "gen_x", label: "Gen X" },
  { value: "mature", label: "Mature" },
];

const PITCH_OPTIONS: { value: VoicePitch; label: string }[] = [
  { value: "very_low", label: "Deep" },
  { value: "low", label: "Lower" },
  { value: "default", label: "Default" },
  { value: "high", label: "Higher" },
  { value: "very_high", label: "High" },
];

const TEXTURE_OPTIONS: { value: VoiceTexture; label: string }[] = [
  { value: "default", label: "Default" },
  { value: "raspy", label: "Raspy" },
  { value: "breathy", label: "Breathy" },
  { value: "husky", label: "Husky" },
  { value: "bright", label: "Bright" },
];

interface VoicePickerProps {
  value: VoiceOptions;
  onChange: (value: VoiceOptions) => void;
}

function PillRow<T extends string>({
  label,
  options,
  selected,
  onSelect,
}: {
  label: string;
  options: { value: T; label: string }[];
  selected: T;
  onSelect: (value: T) => void;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <div className={styles.pills}>
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            className={`${styles.pill} ${selected === o.value ? styles.active : ""}`}
            onClick={() => onSelect(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

export default function VoicePicker({ value, onChange }: VoicePickerProps) {
  return (
    <div className={styles.root}>
      <label className={styles.label}>Voice</label>
      <PillRow
        label="Style"
        options={AGE_OPTIONS}
        selected={value.age}
        onSelect={(age) => onChange({ ...value, age })}
      />
      <PillRow
        label="Pitch"
        options={PITCH_OPTIONS}
        selected={value.pitch}
        onSelect={(pitch) => onChange({ ...value, pitch })}
      />
      <PillRow
        label="Texture"
        options={TEXTURE_OPTIONS}
        selected={value.texture}
        onSelect={(texture) => onChange({ ...value, texture })}
      />
    </div>
  );
}
