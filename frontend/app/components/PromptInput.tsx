"use client";

import {TextArea} from '@astryxdesign/core/TextArea';

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
}: PromptInputProps) {
  return (
    <TextArea
      label={label}
      value={value}
      changeAction={(val) => onChange(val)}
      placeholder={placeholder}
      maxLength={maxLength}
    />
  );
}
