import Link from "next/link";
import { BlurImage } from "@/components/ui/blur-image";
import { PHOTOS, photoSrc } from "@/lib/photos";

/**
 * The gallery.
 *
 * Every tile is a `<Link>`, and that is load-bearing rather than incidental:
 * interception only happens on a client-side navigation. An `<a>`, a
 * `router.refresh()`, or anything that triggers a document request goes
 * straight to `/photos/[id]` and bypasses `@modal/(.)photos/[id]` entirely —
 * which is the correct behaviour for a shared link and the wrong one for a
 * click inside the gallery.
 */
export function PhotoGrid() {
  return (
    <ul className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
      {PHOTOS.map((photo, index) => (
        <li key={photo.id}>
          <Link
            href={`/photos/${photo.id}`}
            className="group flex flex-col gap-2 rounded-xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--primary)] focus-visible:ring-offset-2"
          >
            <div className="relative aspect-[3/2] overflow-hidden rounded-xl">
              <BlurImage
                // A thumbnail-sized upstream fetch. The grid never displays
                // more than ~500 CSS px per tile, so asking for the 1600px
                // original here would be paid for on the first paint of the
                // page most visitors land on.
                src={photoSrc(photo, 800)}
                alt={photo.alt}
                fill
                containerClassName="rounded-xl"
                className="object-cover transition-transform duration-300 group-hover:scale-105"
                sizes="(max-width: 640px) 100vw, (max-width: 1024px) 50vw, 33vw"
                // Only the first tile is likely to be above the fold on a
                // phone; marking all of them priority would be the same as
                // marking none.
                priority={index === 0}
              />
            </div>
            <span className="font-medium leading-snug group-hover:underline">
              {photo.title}
            </span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
