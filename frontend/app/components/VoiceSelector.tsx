"use client";

import { useEffect, useState } from "react";
import styles from "./VoiceSelector.module.css";

interface Voice {
  id: string;
  name: string;
  gender: string;
}

interface VoiceSelectorProps {
  value: string;
  onChange: (value: string) => void;
}

export default function VoiceSelector({ value, onChange }: VoiceSelectorProps) {
  const [voices, setVoices] = useState<Voice[]>([]);

  useEffect(() => {
    fetch("/api/voices")
      .then((r) => r.json())
      .then((data) => setVoices(data))
      .catch(() => {
        // Fallback voices if backend isn't running
        setVoices([
          { id: "en-US-Journey-D", name: "Journey D (Male)", gender: "MALE" },
          { id: "en-US-Journey-F", name: "Journey F (Female)", gender: "FEMALE" },
          { id: "en-US-Studio-M", name: "Studio M (Male)", gender: "MALE" },
          { id: "en-US-Studio-O", name: "Studio O (Female)", gender: "FEMALE" },
        ]);
      });
  }, []);

  const maleVoices = voices.filter((v) => v.gender === "MALE");
  const femaleVoices = voices.filter((v) => v.gender === "FEMALE");

  return (
    <div className={styles.wrapper}>
      <label className={styles.label}>Voice</label>
      <select
        className={styles.select}
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {maleVoices.length > 0 && (
          <optgroup label="Male">
            {maleVoices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </optgroup>
        )}
        {femaleVoices.length > 0 && (
          <optgroup label="Female">
            {femaleVoices.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </optgroup>
        )}
      </select>
    </div>
  );
}
