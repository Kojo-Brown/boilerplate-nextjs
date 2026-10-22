import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PhotoDetail } from "../_components/photo-detail";
import { getPhotoById, getPhotoIds, photoSrc } from "@/lib/photos";

/**
 * The un-intercepted route: what a shared link, a refresh, or a new tab gets.
 *
 * This file is the reason an intercepting route is worth the extra directory.
 * A modal built out of client state has no URL, so there is nothing to share
 * and nothing to reload. Here the modal *is* this page, reached by a soft
 * navigation — so the address bar is always meaningful, and this component is
 * what makes the address bar's promise true.
 */
export function generateStaticParams(): { id: string }[] {
  return getPhotoIds().map((id) => ({ id }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>;
}): Promise<Metadata> {
  const { id } = await params;
  const photo = getPhotoById(id);
  if (!photo) return { title: "Photo not found" };

  // Open Graph tags are not decoration on this route. "Shareable URL" means
  // someone pastes it into a chat window, and what they see there is this.
  return {
    title: photo.title,
    description: photo.caption,
    openGraph: {
      title: photo.title,
      description: photo.caption,
      type: "article",
      images: [{ url: photoSrc(photo, 1200), alt: photo.alt }],
    },
    twitter: {
      card: "summary_large_image",
      title: photo.title,
      description: photo.caption,
      images: [photoSrc(photo, 1200)],
    },
  };
}

export default async function PhotoPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const photo = getPhotoById(id);
  if (!photo) notFound();

  return (
    <article>
      <PhotoDetail photo={photo} variant="page" />
    </article>
  );
}
