export default function UploadLoading() {
  return (
    <div className="flex flex-col gap-6 animate-pulse">
      <div className="flex flex-col gap-1">
        <div className="h-8 w-48 rounded-md bg-[var(--muted)]" />
        <div className="h-4 w-80 rounded-md bg-[var(--muted)]" />
      </div>
      <div className="h-64 rounded-xl border bg-[var(--muted)]" />
    </div>
  );
}
