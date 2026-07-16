"use client";

import styles from "./StylePicker.module.css";

export type PresenterStyle =
  | "social_media"
  | "personal"
  | "news"
  | "educational"
  | "storytelling"
  | "review"
  | "motivational";

interface StyleOption {
  value: PresenterStyle;
  emoji: string;
  label: string;
  description: string;
}

const STYLES: StyleOption[] = [
  {
    value: "social_media",
    emoji: "📱",
    label: "Social Media",
    description: "Quick-hit viral content",
  },
  {
    value: "personal",
    emoji: "🪞",
    label: "Personal Story",
    description: "First-person anecdote",
  },
  {
    value: "news",
    emoji: "📰",
    label: "News Report",
    description: "Objective factual briefing",
  },
  {
    value: "educational",
    emoji: "🎓",
    label: "Educational",
    description: "Teaching & explainer",
  },
  {
    value: "storytelling",
    emoji: "📖",
    label: "Storytelling",
    description: "Narrative third-person",
  },
  {
    value: "review",
    emoji: "⭐",
    label: "Review",
    description: "Honest evaluation",
  },
  {
    value: "motivational",
    emoji: "💪",
    label: "Motivational",
    description: "Inspirational & empowering",
  },
];

interface StylePickerProps {
  value: PresenterStyle;
  onChange: (value: PresenterStyle) => void;
}

export default function StylePicker({ value, onChange }: StylePickerProps) {
  return (
    <div className={styles.root}>
      <label className={styles.label}>Script Style</label>
      <div className={styles.list}>
        {STYLES.map((s) => (
          <button
            key={s.value}
            type="button"
            className={`${styles.option} ${value === s.value ? styles.active : ""}`}
            onClick={() => onChange(s.value)}
            title={s.description}
          >
            <span className={styles.emoji}>{s.emoji}</span>
            <div className={styles.text}>
              <span className={styles.name}>{s.label}</span>
              <span className={styles.desc}>{s.description}</span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
