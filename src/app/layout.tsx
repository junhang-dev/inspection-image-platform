import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "PlantPilot · 검사·보수 통합 관제",
  description: "플랜트파일럿 · 검사 계획부터 사진 판독과 후속 관리까지",
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
