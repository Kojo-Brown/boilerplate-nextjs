import Link from "next/link";

export default function PhotoNotFound() {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <h2 className="text-xl font-semibold">Photo not found</h2>
      <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
        No photo in the catalogue has that ID.
      </p>
      <Link
        href="/photos"
        className="rounded-lg border px-4 py-2 text-sm font-medium transition-opacity hover:opacity-80"
        style={{ borderColor: "var(--border)" }}
      >
        Back to photos
      </Link>
    </div>
  );
}
