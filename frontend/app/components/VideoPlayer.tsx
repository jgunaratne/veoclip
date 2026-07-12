"use client";

import styles from "./VideoPlayer.module.css";

interface VideoPlayerProps {
  src: string;
  poster?: string;
}

export default function VideoPlayer({ src, poster }: VideoPlayerProps) {
  return (
    <div className={`glass ${styles.playerWrap}`}>
      <video
        className={styles.video}
        src={src}
        poster={poster}
        controls
        autoPlay
        playsInline
      />
    </div>
  );
}
