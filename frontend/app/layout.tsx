import type { Metadata, Viewport } from "next";
import { Providers } from "@/components/providers";
import { themeScript } from "@/components/theme";
import "./globals.css";
export const metadata: Metadata = {
  title: "Relay — A little closer",
  description:
    "A thoughtful space for conversations, teams, and ideas. Telegram-inspired messaging.",
};
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f5f7fb",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" data-theme="light" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body>
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
