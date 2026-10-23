import type { Metadata } from "next";
import { Suspense } from "react";
import { AdminFrame } from "./_components/admin-frame";
import {
  AdminSessionFields,
  AdminSessionFieldsFallback,
} from "./_components/admin-session-fields";

export const metadata: Metadata = {
  title: "Admin",
  description: "Admin panel",
};

/**
 * Synchronous on purpose — see `docs/streaming.md`. The heading and the card
 * chrome say the same thing to every administrator, so they prerender; only the
 * four session values stream.
 */
export default function AdminPage() {
  return (
    <AdminFrame
      fields={
        <Suspense fallback={<AdminSessionFieldsFallback />}>
          <AdminSessionFields />
        </Suspense>
      }
    />
  );
}
