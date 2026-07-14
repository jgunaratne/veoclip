"use client";

import { useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./Sidebar.module.css";

const NAV_ITEMS = [
  { href: "/story-mode", label: "Story Mode", icon: "📝" },
  { href: "/presenter-mode", label: "Presenter Mode", icon: "🎤" },
];

export default function Sidebar() {
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  return (
    <>
      <button
        className={styles.hamburger}
        onClick={() => setOpen(true)}
        aria-label="Open navigation"
      >
        ☰
      </button>

      {/* Backdrop */}
      <div
        className={`${styles.backdrop} ${open ? styles.backdropVisible : ""}`}
        onClick={() => setOpen(false)}
      />

      {/* Sidebar panel */}
      <aside className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`}>
        <div className={styles.header}>
          <span className={styles.brand}>🎬 VeoClip</span>
          <button
            className={styles.close}
            onClick={() => setOpen(false)}
            aria-label="Close navigation"
          >
            ✕
          </button>
        </div>

        <nav className={styles.nav}>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navLink} ${pathname === item.href ? styles.navLinkActive : ""}`}
              onClick={() => setOpen(false)}
            >
              <span className={styles.navIcon}>{item.icon}</span>
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
    </>
  );
}
