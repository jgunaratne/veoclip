"use client";

import Link from "next/link";
import styles from "./Navbar.module.css";

export default function Navbar() {
  return (
    <nav className={`glass ${styles.navbar}`}>
      <Link href="/" className={styles.brand}>
        <span className={styles.logo}>🎬</span>
        <span className={styles.name}>VeoClip</span>
      </Link>
    </nav>
  );
}
