import { notFound } from "next/navigation";
import { PhotoDetail } from "@/app/photos/_components/photo-detail";
import { PhotoModal } from "@/app/photos/_components/photo-modal";
import { getPhotoById, getPhotoIds } from "@/lib/photos";

/**
 * The interceptor.
 *
 * `(.)photos/[id]` means "match `/photos/[id]` at the same routing level as
 * this slot". The slot lives at `app/@modal`, whose level is the application
 * root, so the target is `app/photos/[id]` — the sibling of `@modal`, not
 * anything relative to this file's own depth on disk. Getting that marker
 * wrong (`(..)`, or nesting the slot a segment lower) does not fail the build:
 * the interception simply never fires and every click becomes a full-page
 * navigation, silently. `src/app/photos/interception.test.ts` asserts the path
 * for that reason.
 *
 * Next renders this *instead of* `photos/[id]` only for a client-side
 * navigation. A reload, a new tab, or a shared link is a document request, and
 * the router does not intercept those — they fall through to the real route.
 * That fall-through is the feature: the modal has a URL that means something
 * when someone else opens it.
 */
export function generateStaticParams(): { id: string }[] {
  // The interceptor is prerendered on the same terms as the route it shadows.
  // Without this, opening the modal would fetch an on-demand render of a page
  // whose content is already static — a network round trip to learn something
  // the build already knew.
  return getPhotoIds().map((id) => ({ id }));
}

export default async function InterceptedPhotoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const photo = getPhotoById(id);
  if (!photo) notFound();

  return (
    <PhotoModal title={photo.title} description={photo.caption}>
      <PhotoDetail photo={photo} variant="modal" />
    </PhotoModal>
  );
}
