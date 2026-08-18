import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import AppNav from "@/components/AppNav";
import { BRAND } from "@/lib/brand";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: { default: BRAND.name, template: `%s · ${BRAND.name}` },
  description: BRAND.description,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="flex min-h-full flex-col">
        {/*
          The nav is sticky and carries seven links and a search box before any
          page content begins, so it sits between a keyboard or screen-reader user
          and every page, on every page. The skip link is the first thing in the
          tab order and is invisible until focused.

          `tabIndex={-1}` on the target is what makes it work: without it the
          browser moves the URL fragment but leaves focus where it was, so the next
          Tab press starts from the top of the nav again.
        */}
        <a
          href="#main-content"
          className="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-50 focus:rounded-lg focus:border focus:border-line focus:bg-surface-raised focus:px-4 focus:py-2 focus:text-sm focus:font-medium"
        >
          Skip to content
        </a>
        <AppNav />
        <main id="main-content" tabIndex={-1} className="flex-1 outline-none">
          {children}
        </main>
      </body>
    </html>
  );
}
