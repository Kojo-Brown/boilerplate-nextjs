import { EditorFrame } from "./_components/editor-frame";
import { EditorSectionFallback } from "./_components/editor-section";

/**
 * Renders the same frame as the page and the same fallback as the page's own
 * boundary, so navigating into the editor and reloading it show the same thing.
 */
export default function EditPostLoading() {
  return <EditorFrame editor={<EditorSectionFallback />} />;
}
