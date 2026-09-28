"use client";

import { useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { ALLOWED_MIME_TYPES, MAX_FILE_SIZE_BYTES } from "@/lib/uploads/policy";
import { SNIFF_BYTE_COUNT, sniffImageType } from "@/lib/uploads/sniff";
import {
  finalizeUploadAction,
  getPresignedUploadUrlAction,
} from "@/actions/upload";

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
  // The object is in the bucket and the server is reading its header bytes
  // back, sniffing them and scanning it. Its own state rather than a 100%
  // `uploading`, because it is the step that can still refuse the file and the
  // progress bar has nothing left to say about it.
  | { status: "verifying" }
  | {
      status: "done";
      publicUrl: string;
      previewUrl: string;
      /** False when no scanner was configured server-side. */
      scanned: boolean;
    }
  | { status: "error"; message: string };

const MAX_MB = MAX_FILE_SIZE_BYTES / (1024 * 1024);
const ACCEPTED = ALLOWED_MIME_TYPES.join(",");

/**
 * PUTs a file to a presigned URL, reporting progress.
 *
 * Lives outside the component, and that is load-bearing rather than tidiness.
 * React Compiler does not support a value block — a conditional, a logical
 * operator, an optional call — inside a `try`/`catch`, and it fails the *whole
 * enclosing component*, not the statement: with this body inlined, the
 * `onUploadComplete?.(publicUrl)` after the `await` bailed `ImageUpload` out
 * entirely, and `panicThreshold: "none"` meant the build said nothing about
 * it. A module-scope async function is not a component or a hook, so the
 * compiler skips it by design and the bail-out has nowhere to propagate to.
 *
 * `XMLHttpRequest` rather than `fetch` because upload progress is the point,
 * and `fetch` still has no request-body progress in any shipping browser.
 *
 * See docs/react-compiler.md.
 */
async function putToPresignedUrl({
  file,
  uploadUrl,
  onProgress,
}: {
  file: File;
  uploadUrl: string;
  onProgress: (percent: number) => void;
}): Promise<{ success: true } | { success: false; error: string }> {
  try {
    const xhr = new XMLHttpRequest();
    xhr.upload.addEventListener("progress", (ev) => {
      if (ev.lengthComputable) {
        onProgress(Math.round((ev.loaded / ev.total) * 100));
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
      xhr.addEventListener("error", () =>
        reject(new Error("Network error during upload")),
      );
      xhr.open("PUT", uploadUrl);
      xhr.setRequestHeader("Content-Type", file.type);
      xhr.setRequestHeader("x-amz-content-sha256", "UNSIGNED-PAYLOAD");
      xhr.send(file);
    });

    return { success: true };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Upload failed",
    };
  }
}

export function ImageUpload({
  onUploadComplete,
  onUploadError,
  className,
  disabled = false,
}: ImageUploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [state, setState] = useState<UploadState>({ status: "idle" });

  function handleClick() {
    if (
      disabled ||
      state.status === "uploading" ||
      state.status === "verifying"
    )
      return;
    inputRef.current?.click();
  }

  function handleReset() {
    setState({ status: "idle" });
    if (inputRef.current) inputRef.current.value = "";
  }

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    const fail = (message: string) => {
      setState({ status: "error", message });
      onUploadError?.(message);
    };

    // Every check below this line is also made on the server, and none of them
    // is trusted from here: `getPresignedUploadUrlAction` re-validates the type
    // and the size, and `finalizeUploadAction` decides the question these
    // cannot — what the bytes actually are. They run anyway because a file the
    // server is going to refuse should not cost a round trip and a 5 MB upload
    // first, and because "wrong file" is a better message when it arrives
    // before the progress bar than after it.
    if (
      !ALLOWED_MIME_TYPES.includes(
        file.type as (typeof ALLOWED_MIME_TYPES)[number],
      )
    ) {
      fail("File type not allowed. Accepted: JPEG, PNG, WebP and GIF.");
      return;
    }

    if (file.size > MAX_FILE_SIZE_BYTES) {
      fail(`File exceeds the ${MAX_MB} MB limit.`);
      return;
    }

    // The same sniff the server performs, on the same bytes, before anything is
    // uploaded. Not a security control — it runs in the caller's own browser,
    // which is the one place a check can be removed with a debugger — but it
    // turns the commonest honest mistake (a `.png` that a converter left as a
    // JPEG, an image renamed by hand) into an immediate message instead of a
    // slow upload followed by a rejection. `file.slice` reads only the header.
    const header = new Uint8Array(
      await file.slice(0, SNIFF_BYTE_COUNT).arrayBuffer(),
    );
    const detected = sniffImageType(header);
    if (detected !== file.type) {
      fail(
        detected === null
          ? "That file's contents are not a JPEG, PNG, WebP or GIF image."
          : `That file is named as ${file.type} but its contents are a ${detected}.`,
      );
      return;
    }

    const previewUrl = URL.createObjectURL(file);
    setState({ status: "uploading", progress: 0 });

    // 1. Mint a presigned PUT. It writes to a quarantine key and comes back
    //    without any URL the object can be read from — there is nothing to hand
    //    out for an object nobody has looked at yet.
    const result = await getPresignedUploadUrlAction({
      filename: file.name,
      contentType: file.type,
      sizeBytes: file.size,
    });

    if (!result.success) {
      URL.revokeObjectURL(previewUrl);
      fail(result.error);
      return;
    }

    const { uploadUrl, key } = result.data;

    // 2. PUT the file straight to S3. `Content-Length` is signed into that URL,
    //    so the browser's own header has to match the size declared above; it
    //    does, because this is the file whose size was declared.
    const upload = await putToPresignedUrl({
      file,
      uploadUrl,
      onProgress: (progress) => setState({ status: "uploading", progress }),
    });

    if (!upload.success) {
      URL.revokeObjectURL(previewUrl);
      fail(upload.error);
      return;
    }

    // 3. Ask the server to verify what landed and publish it. This is the step
    //    that returns a URL, and the only one that ever does.
    setState({ status: "verifying" });

    const finalized = await finalizeUploadAction({
      key,
      sizeBytes: file.size,
    });

    if (!finalized.success) {
      URL.revokeObjectURL(previewUrl);
      fail(finalized.error);
      return;
    }

    setState({
      status: "done",
      publicUrl: finalized.data.publicUrl,
      previewUrl,
      scanned: finalized.data.scanned,
    });
    onUploadComplete?.(finalized.data.publicUrl);
  }

  const isUploading = state.status === "uploading";
  const isVerifying = state.status === "verifying";
  const isBusy = isUploading || isVerifying;
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
        disabled={disabled || isBusy}
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
            <span className="text-[var(--muted-foreground)] truncate">
              {state.publicUrl}
            </span>
            {/*
              Shown rather than only logged. The server accepts an unscanned
              upload when no scanner is configured, which is a supported state —
              and one the person looking at the result is entitled to know
              about, rather than it being a line in a log they will never read.
            */}
            {!state.scanned && (
              <span
                className="shrink-0 text-xs text-amber-600 dark:text-amber-400"
                title="No malware scanner is configured on this server, so this file was accepted without being scanned."
              >
                Not scanned
              </span>
            )}
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
          disabled={disabled || isBusy}
          className={cn(
            "flex h-40 w-full cursor-pointer flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed transition-colors",
            "hover:border-[var(--primary)] hover:bg-[var(--primary)]/5",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-1",
            "disabled:cursor-not-allowed disabled:opacity-50",
            isError && "border-red-400 bg-red-50 dark:bg-red-950/20",
          )}
          aria-busy={isBusy}
        >
          {isUploading ? (
            <>
              <UploadIcon className="h-8 w-8 animate-bounce text-[var(--primary)]" />
              <span className="text-sm font-medium">
                Uploading… {state.progress}%
              </span>
              <ProgressBar value={state.progress} />
            </>
          ) : isVerifying ? (
            <>
              <UploadIcon className="h-8 w-8 animate-pulse text-[var(--primary)]" />
              <span className="text-sm font-medium">Verifying…</span>
              <span className="text-xs text-[var(--muted-foreground)]">
                Checking the file&rsquo;s contents
              </span>
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
                  isError
                    ? "text-red-600 dark:text-red-400"
                    : "text-[var(--foreground)]",
                )}
              >
                {isError ? "Try again" : "Click to upload"}
              </span>
              <span
                className={cn(
                  "text-xs",
                  isError ? "text-red-500" : "text-[var(--muted-foreground)]",
                )}
              >
                {isError
                  ? state.message
                  : `JPEG, PNG, WebP, GIF — max ${MAX_MB} MB`}
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
