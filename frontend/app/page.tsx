import Link from "next/link";
import styles from "./page.module.css";

export default function Home() {
  return (
    <div className={styles.hero}>
      <div className={styles.heroContent}>
        <h1 className={styles.heroTitle}>
          Turn Your Text and Photos Into Story Videos
        </h1>
        <p className={styles.heroSub}>
          Paste any text, add a few images, pick a length — AI writes the
          story, narrates it, and renders a vertical video ready for social
          media.
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
              Paste the text your story is based on and drop in images — they
              anchor scenes throughout your video.
            </p>
          </div>
          <div className={`glass ${styles.featureCard}`}>
            <span className={styles.featureIcon}>🎬</span>
            <h3 className={styles.featureTitle}>
              <span className={styles.stepNumber}>2</span>Generate
            </h3>
            <p className={styles.featureDesc}>
              Pick 30 seconds, 1 minute, or 3 minutes. Gemini writes the
              narration and scenes; Veo films them.
            </p>
          </div>
          <div className={`glass ${styles.featureCard}`}>
            <span className={styles.featureIcon}>⬇️</span>
            <h3 className={styles.featureTitle}>
              <span className={styles.stepNumber}>3</span>Download
            </h3>
            <p className={styles.featureDesc}>
              Preview in-browser and download a vertical MP4 with synced
              narration, ready to post.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
