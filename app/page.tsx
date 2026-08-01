import type { Metadata } from "next";
import Dashboard from "./dashboard";

export const metadata: Metadata = {
  title: "Overview",
  description: "Manage companies, members, albums, and media.",
};

export default function Home() {
  return <Dashboard />;
}
