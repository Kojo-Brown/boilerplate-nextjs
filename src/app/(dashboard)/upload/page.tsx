import type { Metadata } from "next";
import { UploadDemo } from "./_components/upload-demo";

export const metadata: Metadata = {
  title: "Image Upload",
  description: "Upload images via S3 presigned URLs",
};

/**
 * Synchronous, and therefore fully static — see `docs/streaming.md`.
 *
 * The page is a heading and a Client Component; nothing on it is derived from
 * the session. The upload itself is, and that check has always lived where it
 * belongs: `getPresignedUploadUrlAction` calls `auth()` and refuses to sign a
 * URL without a user id, which is the check that actually protects the bucket —
 * a Server Action is reachable whether or not anyone renders this page.
 *
 * Route access is now the proxy's job (`PROTECTED_PREFIXES`), so dropping the
 * page-level read removes a redirect that ran after the response had already
 * begun, not a check.
 */
export default function UploadPage() {
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
