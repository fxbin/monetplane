import type { Metadata } from "next";
import type { ReactNode } from "react";
import { getLocale } from "@/i18n/server";
import "./globals.css";

export const metadata: Metadata = {
  title: "MonetPlane",
  description:
    "Open-source monetization control plane for multi-product builders.",
};

export default async function RootLayout({
  children,
}: Readonly<{ children: ReactNode }>) {
  const locale = await getLocale();
  return (
    <html lang={locale}>
      <body>{children}</body>
    </html>
  );
}
