import type { Metadata } from "next";
import { PhotoGrid } from "./_components/photo-grid";

export const metadata: Metadata = {
  title: "Photos",
  description:
    "Gallery demonstrating intercepting routes — a detail view that opens as a modal but keeps a shareable URL",
};

export default function PhotosPage() {
  return (
    <div className="flex flex-col gap-8">
      <div className="flex flex-col gap-3">
        <h1 className="text-3xl font-bold tracking-tight">Photos</h1>
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          Click a photo to open it in a modal. The URL changes to{" "}
          <code
            className="rounded px-1 font-mono text-xs"
            style={{ backgroundColor: "var(--border)" }}
          >
            /photos/&lt;id&gt;
          </code>{" "}
          while the gallery stays behind it.
        </p>

        <div
          className="rounded-lg border px-4 py-3 text-sm"
          style={{
            borderColor: "var(--border)",
            backgroundColor: "var(--muted)",
            color: "var(--muted-foreground)",
          }}
        >
          <strong
            className="font-semibold"
            style={{ color: "var(--foreground)" }}
          >
            Intercepting routes demo:
          </strong>{" "}
          The same URL renders two ways. A click from this page is a soft
          navigation, so{" "}
          <code
            className="rounded px-1 font-mono text-xs"
            style={{ backgroundColor: "var(--border)" }}
          >
            @modal/(.)photos/[id]
          </code>{" "}
          intercepts it and renders a dialog. Reloading that URL, opening it in
          a new tab, or sharing it is a hard navigation, so it falls through to{" "}
          <code
            className="rounded px-1 font-mono text-xs"
            style={{ backgroundColor: "var(--border)" }}
          >
            photos/[id]
          </code>{" "}
          and renders a full page. Escape or Back closes the modal, because
          closing it <em>is</em> the Back navigation. See{" "}
          <a
            href="https://github.com/Kojo-Brown/boilerplate-nextjs/blob/main/docs/intercepting-routes.md"
            className="underline underline-offset-4"
          >
            docs/intercepting-routes.md
          </a>
          .
        </div>
      </div>

      <PhotoGrid />
    </div>
  );
}
