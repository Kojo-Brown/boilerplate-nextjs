import type { Metadata } from "next";
import { getRequiredSession } from "@/lib/session";
import { UploadDemo } from "./_components/upload-demo";

export const metadata: Metadata = {
  title: "Image Upload",
  description: "Upload images via S3 presigned URLs",
};

/**
 * `/upload` is not in `PROTECTED_PREFIXES`, so the proxy does not gate it. It
 * was protected only by the session read in `(dashboard)/layout.tsx`; now that
 * the layout is synchronous, the check lives here where it applies on every
 * navigation rather than only on a full page load.
 */
export default async function UploadPage() {
  await getRequiredSession();

  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Image Upload</h1>
        <p
          className="mt-1 text-sm"
          style={{ color: "var(--muted-foreground)" }}
        >
          Upload images directly to S3 using presigned URLs from a Server
          Action.
        </p>
      </div>

      <UploadDemo />
    </div>
  );
}
