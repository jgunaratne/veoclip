"use client";

import Navbar from "../components/Navbar";
import styles from "./page.module.css";

export default function PresenterModePage() {
  return (
    <>
      <Navbar />
      <main className={styles.main}>
        <div className={styles.hero}>
          <span className={styles.icon}>🎤</span>
          <h1 className={styles.title}>Presenter Mode</h1>
          <p className={styles.subtitle}>
            Record yourself presenting while AI generates matching visuals in real-time.
          </p>
          <span className={styles.badge}>Coming Soon</span>
        </div>
      </main>
    </>
  );
}
