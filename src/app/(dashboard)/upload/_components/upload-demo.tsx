"use client";

import { useState } from "react";
import { ImageUpload } from "@/components/ui/image-upload";
import { toast } from "sonner";

export function UploadDemo() {
  const [uploadedUrl, setUploadedUrl] = useState<string | null>(null);

  function handleComplete(url: string) {
    setUploadedUrl(url);
    toast.success("Image uploaded successfully");
  }

  function handleError(message: string) {
    toast.error(message);
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="rounded-xl border p-6" style={{ backgroundColor: "var(--background)" }}>
        <h2
          className="mb-4 text-sm font-medium uppercase tracking-wider"
          style={{ color: "var(--muted-foreground)" }}
        >
          Upload an Image
        </h2>
        <ImageUpload onUploadComplete={handleComplete} onUploadError={handleError} />
      </div>

      {uploadedUrl && (
        <div className="rounded-xl border p-6" style={{ backgroundColor: "var(--background)" }}>
          <h2
            className="mb-2 text-sm font-medium uppercase tracking-wider"
            style={{ color: "var(--muted-foreground)" }}
          >
            Public URL
          </h2>
          <p className="break-all font-mono text-sm">{uploadedUrl}</p>
        </div>
      )}

      <div className="rounded-xl border p-6 text-sm" style={{ backgroundColor: "var(--background)" }}>
        <h2
          className="mb-3 text-sm font-medium uppercase tracking-wider"
          style={{ color: "var(--muted-foreground)" }}
        >
          How it works
        </h2>
        <ol className="list-decimal list-inside space-y-2" style={{ color: "var(--muted-foreground)" }}>
          <li>
            The client sends file metadata (name, type, size) to the{" "}
            <code className="rounded bg-[var(--muted)] px-1 py-0.5 font-mono text-xs">
              getPresignedUploadUrlAction
            </code>{" "}
            Server Action.
          </li>
          <li>
            The server validates the file and generates a time-limited presigned PUT URL using AWS
            Signature V4 (no SDK — pure Web Crypto API).
          </li>
          <li>
            The browser uploads the file directly to S3 using the presigned URL — the file never
            passes through the Next.js server.
          </li>
          <li>The public URL is returned to the client for use in your application.</li>
        </ol>
      </div>
    </div>
  );
}
