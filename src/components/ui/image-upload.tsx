"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from "@/lib/s3";
import { getPresignedUploadUrlAction } from "@/actions/upload";

export interface ImageUploadProps {
  onUploadComplete?: (publicUrl: string) => void;
  onUploadError?: (message: string) => void;
  className?: string;
  disabled?: boolean;
}

type UploadState =
  | { status: "idle" }
  | { status: "selecting" }
  | { status: "uploading"; progress: number }
  | { status: "done"; publicUrl: string; previewUrl: string }
  | { status: "error"; message: string };

const MAX_MB = MAX_FILE_SIZE_BYTES / (1024 * 1024);
const ACCEPTED = ALLOWED_MIME_TYPES.join(",");

export function ImageUpload({
  onUploadComplete,
  onUploadError,
  className,
  disabled = false,
}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ status: "idle" });

  function handleClick() {
    if (disabled || state.status === "uploading") return;
    inputRef.current?.click();
  }

  function handleReset() {
    setState({ status: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    // Client-side validation
    if (!ALLOWED_MIME_TYPES.includes(file.type as (typeof ALLOWED_MIME_TYPES)[number])) {
      const msg = `File type not allowed. Accepted: JPEG, PNG, WebP, GIF, SVG.`;
      setState({ status: "error", message: msg });
      onUploadError?.(msg);
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      const msg = `File exceeds the ${MAX_MB} MB limit.`;
      setState({ status: "error", message: msg });
      onUploadError?.(msg);
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setState({ status: "uploading", progress: 0 });

    // 1. Get a presigned URL from the server
    const result = await getPresignedUploadUrlAction({
      filename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
    });

    if (!result.success) {
      URL.revokeObjectURL(previewUrl);
      setState({ status: "error", message: result.error });
      onUploadError?.(result.error);
      return;
    }

    const { uploadUrl, publicUrl } = result.data;

    // 2. PUT the file directly to S3 using the presigned URL
    try {
      const xhr = new XMLHttpRequest();
      xhr.upload.addEventListener("progress", (ev) => {
        if (ev.lengthComputable) {
          setState({ status: "uploading", progress: Math.round((ev.loaded / ev.total) * 100) });
        }
      });

      await new Promise<void>((resolve, reject) => {
        xhr.addEventListener("load", () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            resolve();
          } else {
            reject(new Error(`Upload failed with status ${xhr.status}`));
          }
        });
        xhr.addEventListener("error", () => reject(new Error("Network error during upload")));
        xhr.open("PUT", uploadUrl);
        xhr.setRequestHeader("Content-Type", file.type);
        xhr.setRequestHeader("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
        xhr.send(file);
      });

      setState({ status: "done", publicUrl, previewUrl });
      onUploadComplete?.(publicUrl);
    } catch (error) {
      URL.revokeObjectURL(previewUrl);
      const msg = error instanceof Error ? error.message : "Upload failed";
      setState({ status: "error", message: msg });
      onUploadError?.(msg);
    }
  }

  const isUploading = state.status === "uploading";
  const isDone = state.status === "done";
  const isError = state.status === "error";

  return (
    <div className={cn("flex flex-col gap-3", className)}>
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        className="sr-only"
        onChange={handleFileChange}
        disabled={disabled || isUploading}
        aria-label="Upload image"
      />

      {isDone ? (
        <div className="relative flex flex-col items-center gap-3">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={state.previewUrl}
            alt="Uploaded preview"
            className="h-48 w-full rounded-lg border object-cover"
          />
          <div className="flex w-full items-center justify-between gap-2 text-sm">
            <span className="text-[var(--muted-foreground)] truncate">{state.publicUrl}</span>
            <button
              type="button"
              onClick={handleReset}
              className="shrink-0 rounded-md border px-3 py-1 text-sm font-medium transition-colors hover:bg-[var(--muted)]"
            >
              Replace
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={handleClick}
          disabled={disabled || isUploading}
          className={cn(
            "flex h-40 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors",
            "hover:border-[var(--primary)] hover:bg-[var(--primary)]/5",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
            "disabled:cursor-not-allowed disabled:opacity-50",
            isError && "border-red-400 bg-red-50 dark:bg-red-950/20",
          )}
          aria-busy={isUploading}
        >
          {isUploading ? (
            <>
              <UploadIcon className="h-8 w-8 animate-bounce text-[var(--primary)]" />
              <span className="text-sm font-medium">Uploading… {state.progress}%</span>
              <ProgressBar value={state.progress} />
            </>
          ) : (
            <>
              <UploadIcon
                className={cn(
                  "h-8 w-8",
                  isError ? "text-red-500" : "text-[var(--muted-foreground)]",
                )}
              />
              <span
                className={cn(
                  "text-sm font-medium",
                  isError ? "text-red-600 dark:text-red-400" : "text-[var(--foreground)]",
                )}
              >
                {isError ? "Try again" : "Click to upload"}
              </span>
              <span className={cn("text-xs", isError ? "text-red-500" : "text-[var(--muted-foreground)]")}>
                {isError ? state.message : `JPEG, PNG, WebP, GIF, SVG — max ${MAX_MB} MB`}
              </span>
            </>
          )}
        </button>
      )}
    </div>
  );
}

function ProgressBar({ value }: { value: number }) {
  return (
    <div className="h-1.5 w-3/4 overflow-hidden rounded-full bg-[var(--muted)]">
      <div
        className="h-full rounded-full bg-[var(--primary)] transition-all duration-200"
        style={{ width: `${value}%` }}
        role="progressbar"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
      />
    </div>
  );
}

function UploadIcon({ className }: { className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  );
}
