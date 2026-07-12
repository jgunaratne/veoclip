"use client";

import {SegmentedControl, SegmentedControlItem} from '@astryxdesign/core/SegmentedControl';

interface DurationPickerProps {
  value: number;
  onChange: (value: number) => void;
}

// Story length in seconds → generated as chained 8 s Veo segments
const OPTIONS = [
  { value: 30, label: "30s · 4 scenes" },
  { value: 60, label: "1m · 8 scenes" },
  { value: 180, label: "3m · 23 scenes" },
];

export default function DurationPicker({ value, onChange }: DurationPickerProps) {
  return (
    <SegmentedControl
      label="Video duration"
      value={String(value)}
      onChange={(v) => onChange(Number(v))}
    >
      {OPTIONS.map((opt) => (
        <SegmentedControlItem key={opt.value} value={String(opt.value)} label={opt.label} />
      ))}
    </SegmentedControl>
  );
}
