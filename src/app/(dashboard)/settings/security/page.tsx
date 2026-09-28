import type { Metadata } from "next";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { ChangePasswordForm } from "./_components/change-password-form";

export const metadata: Metadata = {
  title: "Security",
  description: "Change your password and sign out of every session",
};

/**
 * Synchronous, and therefore fully static apart from the layout's `<UserChip>`
 * — see `docs/streaming.md`.
 *
 * Nothing on this page is derived from the session, deliberately: it renders
 * three password inputs and a description, and the account the change applies
 * to is read inside `changePasswordAction` from `auth()` rather than carried in
 * a form field. A page that showed "signed in as …" here would trade a
 * prerendered document for a per-request render to tell the reader something
 * the header already streams.
 *
 * Route access is the proxy's job: `/settings` is in `PROTECTED_PREFIXES`. The
 * action's own session assertion is what protects the password, and it holds
 * whether or not anybody renders this page — every export of a `"use server"`
 * module is a POST endpoint.
 */
export default function SecuritySettingsPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Security</h1>
        <p
          className="mt-1 text-sm"
          style={{ color: "var(--muted-foreground)" }}
        >
          Manage the credential this account signs in with.
        </p>
      </div>

      <Card className="max-w-xl">
        <CardHeader>
          <CardTitle>Change password</CardTitle>
          <CardDescription>
            Changing your password signs out every session, including this one.
            A copy of a session cookie taken from another device stops working
            immediately rather than at its own expiry, which is the point of
            changing it.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ChangePasswordForm />
        </CardContent>
      </Card>
    </div>
  );
}
