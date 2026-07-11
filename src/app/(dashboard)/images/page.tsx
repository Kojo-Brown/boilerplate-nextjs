import type { Metadata } from "next";
import { BlurImage } from "@/components/ui/blur-image";
import { shimmerDataUrl } from "@/lib/lqip";

export const metadata: Metadata = {
  title: "Image Showcase",
  description: "next/image wrapper with blur placeholder and LQIP demo",
};

const FIXED_SIZE_DEMOS = [
  {
    src: "https://images.unsplash.com/photo-1506905925346-21bda4d32df4?w=800&q=80",
    alt: "Mountain landscape at golden hour",
    label: "Shimmer placeholder (default)",
    description: "Uses an SVG gradient shimmer — no extra dependencies.",
    blurDataURL: undefined as string | undefined,
  },
  {
    src: "https://images.unsplash.com/photo-1542281286-9e0a16bb7366?w=800&q=80",
    alt: "Ocean waves at sunset",
    label: "Custom LQIP blurDataURL",
    description:
      "Pass base64 from plaiceholder as blurDataURL for true low-quality thumbnail.",
    blurDataURL: shimmerDataUrl(32, 21),
  },
];

export default function ImagesPage() {
  return (
    <div className="flex flex-col gap-8">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Image Showcase</h1>
        <p className="mt-1 text-sm" style={{ color: "var(--muted-foreground)" }}>
          next/image wrapper with blur placeholder, shimmer animation, and LQIP
          support.
        </p>
      </div>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Fixed-size images</h2>
        <div className="grid gap-6 sm:grid-cols-2">
          {FIXED_SIZE_DEMOS.map((img) => (
            <div key={img.alt} className="flex flex-col gap-2">
              <BlurImage
                src={img.src}
                alt={img.alt}
                width={800}
                height={534}
                blurDataURL={img.blurDataURL}
                containerClassName="rounded-xl"
                className="w-full object-cover"
                sizes="(max-width: 640px) 100vw, 50vw"
              />
              <p className="text-sm font-medium">{img.label}</p>
              <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
                {img.description}
              </p>
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-4">
        <h2 className="text-lg font-semibold">Fill layout</h2>
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          Use{" "}
          <code className="rounded bg-[var(--muted)] px-1 py-0.5 text-xs">
            fill
          </code>{" "}
          with a sized parent container.
        </p>
        <div className="relative h-72 w-full">
          <BlurImage
            src="https://images.unsplash.com/photo-1519681393784-d120267933ba?w=1200&q=80"
            alt="Stars over snowy mountain range"
            fill
            containerClassName="rounded-xl"
            className="object-cover"
            sizes="100vw"
          />
        </div>
      </section>

      <section
        className="rounded-xl border p-6"
        style={{ backgroundColor: "var(--muted)" }}
      >
        <h2 className="mb-3 text-lg font-semibold">Using real LQIP</h2>
        <pre className="overflow-x-auto rounded-lg bg-[var(--background)] p-4 text-xs leading-relaxed">
          {`// Install plaiceholder for real LQIP thumbnails (optional)
// pnpm add plaiceholder sharp

// In a Server Component or Server Action:
import { getPlaiceholder } from "plaiceholder";

const { base64 } = await getPlaiceholder(
  "https://example.com/my-image.jpg"
);

// Pass base64 as blurDataURL:
<BlurImage
  src="https://example.com/my-image.jpg"
  alt="My image"
  width={800}
  height={600}
  blurDataURL={base64}
/>

// Without plaiceholder, BlurImage uses a shimmer SVG gradient by default.`}
        </pre>
      </section>
    </div>
  );
}
