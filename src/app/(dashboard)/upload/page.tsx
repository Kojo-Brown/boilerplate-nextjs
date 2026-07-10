import type { Metadata } from "next";
import { UploadDemo } from "./_components/upload-demo";

export const metadata: Metadata = {
  title: "Image Upload",
  description: "Upload images via S3 presigned URLs",
};

export default function UploadPage() {
  return (
    <div className="flex flex-col gap-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Image Upload</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted-foreground)" }}>
          Upload images directly to S3 using presigned URLs from a Server Action.
        </p>
      </div>

      <UploadDemo />
    </div>
  );
}
