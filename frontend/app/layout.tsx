import type { Metadata } from "next";
import "./globals.css";
import { Providers } from "./providers";
import Sidebar from "./components/Sidebar";

export const metadata: Metadata = {
  title: "VeoClip — Turn Images Into Video",
  description:
    "Upload a still image, describe the motion you want, add a voiceover, and generate a video clip with Google Veo.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>
        <Providers>
          <Sidebar />
          {children}
        </Providers>
      </body>
    </html>
  );
}
