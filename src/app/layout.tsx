import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "Drone Inspection Platform",
  description: "드론 검사 플랫폼 · 검사계획부터 사진 판독과 보수 검토까지",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
