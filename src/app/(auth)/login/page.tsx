import type { Metadata } from "next";
import { LoginForm } from "./_components/login-form";

export const metadata: Metadata = {
  title: "Sign In",
  description: "Sign in to your account",
};

export default function LoginPage() {
  return (
    <div
      className="w-full max-w-sm rounded-2xl p-8 shadow-sm"
      style={{ backgroundColor: "var(--background)" }}
    >
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Welcome back</h1>
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          Sign in to your account to continue
        </p>
      </div>
      <LoginForm />
    </div>
  );
}
