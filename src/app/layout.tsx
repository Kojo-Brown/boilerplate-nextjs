import type { Metadata } from "next";
import { Toaster } from "sonner";
import { auth } from "@/auth";
import { SessionProvider } from "@/components/providers/session-provider";
import "@/styles/globals.css";

export const metadata: Metadata = {
  title: { default: "App", template: "%s | App" },
  description: "Next.js boilerplate",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const session = await auth();
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        <SessionProvider session={session}>
          {children}
          <Toaster richColors closeButton />
        </SessionProvider>
      </body>
    </html>
  );
}
