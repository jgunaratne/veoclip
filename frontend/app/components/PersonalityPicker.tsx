"use client";

import styles from "./PersonalityPicker.module.css";

export type PresenterPersonality =
  | "social"
  | "calm"
  | "pensive"
  | "happy"
  | "energetic"
  | "serious"
  | "witty"
  | "warm"
  | "intense";

interface PersonalityOption {
  value: PresenterPersonality;
  emoji: string;
  label: string;
  description: string;
}

const PERSONALITIES: PersonalityOption[] = [
  {
    value: "social",
    emoji: "📱",
    label: "Social",
    description: "Casual & trendy",
  },
  {
    value: "calm",
    emoji: "🧘",
    label: "Calm",
    description: "Relaxed & soothing",
  },
  {
    value: "pensive",
    emoji: "🤔",
    label: "Pensive",
    description: "Reflective & deep",
  },
  {
    value: "happy",
    emoji: "😊",
    label: "Happy",
    description: "Cheerful & bright",
  },
  {
    value: "energetic",
    emoji: "⚡",
    label: "Energetic",
    description: "High-energy & hyped",
  },
  {
    value: "serious",
    emoji: "🎯",
    label: "Serious",
    description: "Authoritative & direct",
  },
  {
    value: "witty",
    emoji: "😏",
    label: "Witty",
    description: "Clever & sharp",
  },
  {
    value: "warm",
    emoji: "🤗",
    label: "Warm",
    description: "Friendly & inviting",
  },
  {
    value: "intense",
    emoji: "🔥",
    label: "Intense",
    description: "Passionate & driven",
  },
];

interface PersonalityPickerProps {
  value: PresenterPersonality;
  onChange: (value: PresenterPersonality) => void;
}

export default function PersonalityPicker({
  value,
  onChange,
}: PersonalityPickerProps) {
  return (
    <div className={styles.root}>
      <label className={styles.label}>Presenter Mood</label>
      <div className={styles.grid}>
        {PERSONALITIES.map((p) => (
          <button
            key={p.value}
            type="button"
            className={`${styles.card} ${value === p.value ? styles.active : ""}`}
            onClick={() => onChange(p.value)}
            title={p.description}
          >
            <span className={styles.emoji}>{p.emoji}</span>
            <span className={styles.name}>{p.label}</span>
            <span className={styles.desc}>{p.description}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
