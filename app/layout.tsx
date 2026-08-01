import type { Metadata } from "next";
import { headers } from "next/headers";
import { AuthProvider } from "./auth-provider";
import "./globals.css";

export async function generateMetadata(): Promise<Metadata> {
  let requestHeaders: Awaited<ReturnType<typeof headers>> | undefined;
  try {
    requestHeaders = await headers();
  } catch {
    requestHeaders = undefined;
  }
  const host = requestHeaders?.get("x-forwarded-host") ?? requestHeaders?.get("host") ?? "localhost:3000";
  const protocol = requestHeaders?.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  const origin = `${protocol}://${host}`;
  return {
    title: { default: "HZ Media", template: "%s · HZ Media" },
    description: "Company albums, images, and video.",
    icons: { icon: "/favicon.svg", shortcut: "/favicon.svg" },
    openGraph: { title: "HZ Media", description: "Company albums and media.", type: "website", url: origin },
    twitter: { card: "summary", title: "HZ Media", description: "Company albums and media." },
  };
}

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body><AuthProvider>{children}</AuthProvider></body></html>;
}
