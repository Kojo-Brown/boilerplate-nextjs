import { useLocale } from "next-intl";
import { Link, getPathname } from "@/i18n/navigation";
import { BlurImage } from "@/components/ui/blur-image";
import { PHOTO_HEIGHT, PHOTO_WIDTH, photoSrc, type Photo } from "@/lib/photos";
import { CopyLinkButton } from "./copy-link-button";

export interface PhotoDetailProps {
  photo: Photo;
  /**
   * `page` — the standalone route at `/photos/[id]`, reached by a hard
   * navigation, a refresh, or someone opening a shared link.
   * `modal` — the same content inside the intercepted overlay, reached by a
   * soft navigation from the gallery.
   */
  variant: "page" | "modal";
}

/**
 * The one rendering of a photo, shared by the route and its interceptor.
 *
 * Keeping this in a single component is the whole discipline of intercepting
 * routes: two route files render the same URL, and the moment they drift the
 * modal and the shared link stop agreeing about what that URL means. The
 * variant covers only what genuinely differs — the modal sits inside a dialog
 * that already owns the heading and the close affordance, and its image box is
 * bounded by the viewport rather than by page flow.
 */
export function PhotoDetail({ photo, variant }: PhotoDetailProps) {
  const isModal = variant === "modal";
  // Read rather than taken as a prop: both callers are pages under the
  // `[locale]` segment, and the layout has already put the locale in
  // `next-intl`'s request cache with `setRequestLocale` — so this is a cache
  // read, not a request-time one, and the route stays prerendered.
  // `scripts/assert-route-shape.ts` is what holds that: `/photos/[id]` is
  // declared `prebuilt` there, so a dynamic read here fails the build.
  const locale = useLocale();

  return (
    <div className="flex flex-col gap-4">
      {!isModal && (
        <>
          <Link
            href="/photos"
            className="text-sm transition-opacity hover:opacity-80"
            style={{ color: "var(--muted-foreground)" }}
          >
            ← All photos
          </Link>
          <h1 className="text-3xl font-bold leading-tight tracking-tight">
            {photo.title}
          </h1>
        </>
      )}

      <div
        className={
          isModal
            ? "relative max-h-[65vh] overflow-hidden rounded-lg"
            : "relative overflow-hidden rounded-xl"
        }
      >
        <BlurImage
          src={photoSrc(photo)}
          alt={photo.alt}
          width={PHOTO_WIDTH}
          height={PHOTO_HEIGHT}
          containerClassName={isModal ? "rounded-lg" : "rounded-xl"}
          className="h-full w-full object-cover"
          // The modal never exceeds `max-w-3xl` and the page is capped by the
          // article width, so neither ever needs a 1600px decode on a phone.
          sizes={
            isModal
              ? "(max-width: 768px) 100vw, 768px"
              : "(max-width: 896px) 100vw, 896px"
          }
          priority={!isModal}
        />
      </div>

      {/* The modal's `<DialogDescription>` already carries the caption, and
          announcing it twice is worse than not showing it at all. */}
      {!isModal && (
        <p className="text-sm" style={{ color: "var(--muted-foreground)" }}>
          {photo.caption}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-3">
        <CopyLinkButton path={`/photos/${photo.id}`} />
        {isModal && (
          // A plain anchor, not `<Link>`. The address bar already reads
          // `/photos/<id>`, so a soft navigation to it is a no-op that would
          // leave the modal exactly where it is. A full page load is the only
          // way to reach the un-intercepted route from inside the interceptor,
          // and it is also what a shared link does — which makes this the
          // fastest way to see that both render the same thing.
          //
          // The href goes through `getPathname` because an anchor gets no
          // locale from anywhere: `<Link>` reads the active one and prefixes
          // the path itself, and a bare `/photos/<id>` resolves to the default
          // locale. So the one link in the application that has to be a full
          // page load was also the one that dropped the visitor's language,
          // which is rule R4 of `scripts/assert-locale-hrefs.ts` — the gate
          // that replaced `no-html-link-for-pages` — finding something that
          // rule never reported.
          <a
            href={getPathname({ href: `/photos/${photo.id}`, locale })}
            className="text-sm underline underline-offset-4 transition-opacity hover:opacity-80"
            style={{ color: "var(--muted-foreground)" }}
          >
            Open full page
          </a>
        )}
      </div>
    </div>
  );
}
