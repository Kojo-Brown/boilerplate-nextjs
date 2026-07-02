import type { Metadata } from "next";
import { RegisterForm } from "./_components/register-form";

export const metadata: Metadata = {
  title: "Create Account",
  description: "Create a new account",
};

export default function RegisterPage() {
  return (
    <div
      className="w-full max-w-sm rounded-2xl p-8 shadow-sm"
      style={{ backgroundColor: "var(--background)" }}
    >
      <div className="mb-6 flex flex-col gap-1">
        <h1 className="text-2xl font-bold tracking-tight">Create an account</h1>
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          Sign up to get started today
        </p>
      </div>
      <RegisterForm />
    </div>
  );
}
