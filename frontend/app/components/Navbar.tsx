"use client";

import {TopNav} from '@astryxdesign/core/TopNav';
import {TopNavHeading} from '@astryxdesign/core/TopNav';
import styles from './Navbar.module.css';

interface NavbarProps {
  onMenuClick?: () => void;
}

export default function Navbar({ onMenuClick }: NavbarProps) {
  return (
    <TopNav
      heading={<TopNavHeading heading="VeoClip" headingHref="/" />}
      startContent={
        <button
          className={styles.menuButton}
          onClick={onMenuClick}
          aria-label="Open navigation"
        >
          ☰
        </button>
      }
      className={styles.nav}
    />
  );
}
