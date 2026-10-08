import type { Metadata } from 'next';
import './globals.css';
export const metadata: Metadata = {
  title: 'Launchdeck · 产品部署工作台',
  description: '从 GitHub 到用户手中。统一管理网页、小程序与移动应用的部署。',
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
