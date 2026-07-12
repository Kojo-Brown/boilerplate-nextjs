/** Server component — receives the render timestamp from the parent page. */
export function IsrBadge({
  renderedAt,
  revalidateSeconds,
}: {
  renderedAt: Date;
  revalidateSeconds: number;
}) {
  const time = renderedAt.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZoneName: "short",
  });

  return (
    <span
      className="inline-flex shrink-0 items-center gap-1.5 rounded-full border px-3 py-1 text-xs font-medium"
      style={{ borderColor: "var(--border)", color: "var(--muted-foreground)" }}
      title={`Revalidates every ${revalidateSeconds}s`}
    >
      <span
        className="size-1.5 rounded-full"
        style={{ backgroundColor: "oklch(65% 0.18 145)" }}
        aria-hidden="true"
      />
      Rendered {time} · ISR {revalidateSeconds}s
    </span>
  );
}
