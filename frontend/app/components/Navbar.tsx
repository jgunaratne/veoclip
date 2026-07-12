"use client";

import {TopNav} from '@astryxdesign/core/TopNav';
import {TopNavHeading} from '@astryxdesign/core/TopNav';

export default function Navbar() {
  return (
    <TopNav
      heading={<TopNavHeading heading="VeoClip" headingHref="/" />}
      startContent={<span>🎬</span>}
    />
  );
}
