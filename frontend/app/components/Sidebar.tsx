"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import styles from "./Sidebar.module.css";

const NAV_ITEMS = [
  { href: "/story-mode", label: "Story Mode", icon: "📝" },
  { href: "/presenter-mode", label: "Presenter Mode", icon: "🎤" },
];

const COMPOSE_ITEMS = [
  { href: "/composite", label: "Composite", icon: "🎭" },
];

const LIBRARY_ITEMS = [
  { href: "/videos", label: "My Videos", icon: "🎬" },
];

interface SidebarProps {
  open: boolean;
  onClose: () => void;
}

export default function Sidebar({ open, onClose }: SidebarProps) {
  const pathname = usePathname();

  return (
    <>
      {/* Backdrop */}
      <div
        className={`${styles.backdrop} ${open ? styles.backdropVisible : ""}`}
        onClick={onClose}
      />

      {/* Sidebar panel */}
      <aside className={`${styles.sidebar} ${open ? styles.sidebarOpen : ""}`}>
        <div className={styles.header}>
          <span className={styles.brand}>🎬 VeoClip</span>
          <button
            className={styles.close}
            onClick={onClose}
            aria-label="Close navigation"
          >
            ✕
          </button>
        </div>

        <nav className={styles.nav}>
          <span className={styles.navSection}>Create</span>
          {NAV_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navLink} ${pathname === item.href ? styles.navLinkActive : ""}`}
              onClick={onClose}
            >
              <span className={styles.navIcon}>{item.icon}</span>
              {item.label}
            </Link>
          ))}

          <span className={styles.navSection}>Compose</span>
          {COMPOSE_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navLink} ${pathname === item.href ? styles.navLinkActive : ""}`}
              onClick={onClose}
            >
              <span className={styles.navIcon}>{item.icon}</span>
              {item.label}
            </Link>
          ))}

          <span className={styles.navSection}>Library</span>
          {LIBRARY_ITEMS.map((item) => (
            <Link
              key={item.href}
              href={item.href}
              className={`${styles.navLink} ${pathname === item.href ? styles.navLinkActive : ""}`}
              onClick={onClose}
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
