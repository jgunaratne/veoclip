"use client";

import { Card } from "@astryxdesign/core/Card";
import styles from "./VideoPlayer.module.css";

interface VideoPlayerProps {
  src: string;
  poster?: string;
}

export default function VideoPlayer({ src, poster }: VideoPlayerProps) {
  return (
    <Card padding={0} className={styles.playerWrap}>
      <video
        className={styles.video}
        src={src}
        poster={poster}
        controls
        autoPlay
        playsInline
      />
    </Card>
  );
}
