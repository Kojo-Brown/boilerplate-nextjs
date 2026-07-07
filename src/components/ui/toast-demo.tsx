"use client";

import { toast } from "@/lib/toast";

export function ToastDemo() {
  return (
    <div className="flex flex-wrap gap-2">
      <button
        type="button"
        onClick={() => toast.success("Changes saved successfully.")}
        className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-green-50 dark:hover:bg-green-950"
      >
        Success
      </button>

      <button
        type="button"
        onClick={() => toast.error("Something went wrong. Please try again.")}
        className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-red-50 dark:hover:bg-red-950"
      >
        Error
      </button>

      <button
        type="button"
        onClick={() => toast.warning("Your session expires in 5 minutes.")}
        className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-yellow-50 dark:hover:bg-yellow-950"
      >
        Warning
      </button>

      <button
        type="button"
        onClick={() => toast.info("A new version is available.")}
        className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-blue-50 dark:hover:bg-blue-950"
      >
        Info
      </button>

      <button
        type="button"
        onClick={() => {
          const id = toast.loading("Uploading file…");
          setTimeout(() => {
            toast.success("File uploaded.", { id });
          }, 2000);
        }}
        className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
      >
        Loading → Success
      </button>

      <button
        type="button"
        onClick={() =>
          toast.promise(
            new Promise<{ name: string }>((resolve) =>
              setTimeout(() => resolve({ name: "report.pdf" }), 1500),
            ),
            {
              loading: "Generating report…",
              success: (data) => `${data.name} is ready.`,
              error: "Failed to generate report.",
            },
          )
        }
        className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
      >
        Promise
      </button>

      <button
        type="button"
        onClick={() => toast.dismiss()}
        className="rounded-lg border px-3 py-1.5 text-sm font-medium transition-colors hover:bg-muted"
      >
        Dismiss all
      </button>
    </div>
  );
}
