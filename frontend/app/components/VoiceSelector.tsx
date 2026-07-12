"use client";

import { useEffect, useState } from "react";
import {Selector} from '@astryxdesign/core/Selector';

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
      .then((data: Voice[]) => {
        setVoices(data);
        // The voice list depends on the backend's auth mode — snap the
        // selection to a real voice if the current one isn't offered.
        if (data.length > 0 && !data.some((v) => v.id === value)) {
          onChange(data[0].id);
        }
      })
      .catch(() => {
        // Fallback voices if backend isn't running
        setVoices([
          { id: "Puck", name: "Puck (Upbeat)", gender: "MALE" },
          { id: "Charon", name: "Charon (Informative)", gender: "MALE" },
          { id: "Kore", name: "Kore (Firm)", gender: "FEMALE" },
          { id: "Aoede", name: "Aoede (Breezy)", gender: "FEMALE" },
        ]);
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Build options sorted by gender (Male first, then Female) to preserve
  // the original optgroup ordering in a flat list.
  const maleVoices = voices.filter((v) => v.gender === "MALE");
  const femaleVoices = voices.filter((v) => v.gender === "FEMALE");
  const options = [
    ...maleVoices.map((v) => ({ value: v.id, label: `${v.name}` })),
    ...femaleVoices.map((v) => ({ value: v.id, label: `${v.name}` })),
  ];

  return (
    <Selector
      label="Voice"
      options={options}
      value={value}
      onChange={onChange}
      placeholder="Select a voice"
    />
  );
}
