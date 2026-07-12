import Link from "next/link";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.hero}>
      <div className={styles.heroContent}>
        <h1 className={styles.heroTitle}>
          Turn Still Images Into Living Stories
        </h1>
        <p className={styles.heroSub}>
          Upload a photo, describe the motion you envision, add a voiceover
          script, and let AI bring it all to life as a cinematic video clip.
        </p>
        <Link href="/create" className={`btn-primary ${styles.heroCta}`}>
          <span>✨ Start Creating</span>
        </Link>

        <div className={styles.features}>
          <div className={`glass ${styles.featureCard}`}>
            <span className={styles.featureIcon}>📸</span>
            <h3 className={styles.featureTitle}>
              <span className={styles.stepNumber}>1</span>Upload
            </h3>
            <p className={styles.featureDesc}>
              Drop in any still image — a photo, illustration, or AI-generated
              artwork — as the seed for your video.
            </p>
          </div>
          <div className={`glass ${styles.featureCard}`}>
            <span className={styles.featureIcon}>🎬</span>
            <h3 className={styles.featureTitle}>
              <span className={styles.stepNumber}>2</span>Generate
            </h3>
            <p className={styles.featureDesc}>
              Describe the motion you want and write a voiceover script. Veo and
              Cloud TTS handle the rest.
            </p>
          </div>
          <div className={`glass ${styles.featureCard}`}>
            <span className={styles.featureIcon}>⬇️</span>
            <h3 className={styles.featureTitle}>
              <span className={styles.stepNumber}>3</span>Download
            </h3>
            <p className={styles.featureDesc}>
              Preview your clip in-browser and download the final MP4 with
              synced narration.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
