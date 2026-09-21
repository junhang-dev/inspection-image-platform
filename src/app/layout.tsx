import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "InspectLoop · 검사 이미지 플랫폼",
  description: "검사 계획부터 사진 판독과 후속 관리까지",
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
