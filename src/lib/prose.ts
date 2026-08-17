/**
 * Turns the plain text stored in `Post.content` into paragraphs.
 *
 * The column is a plain `String?` written through a `<textarea>` in
 * `create-post-dialog.tsx` — no markup, no markdown, just whatever the author
 * typed, blank lines and all. `app/blog/[slug]` used to render the whole thing
 * as one `<p className="whitespace-pre-wrap">`, which collapsed every break
 * the author made into line breaks inside a single block.
 *
 * That is why the typography plugin on its own would not have finished the
 * job. `prose` styles paragraphs — margins, measure, rhythm between them — and
 * a body that is one paragraph has nothing for it to space. Splitting here is
 * what gives it something to style, and it is the reason this is a rendering
 * change rather than only a dependency addition.
 *
 * Deliberately not a markdown renderer. Nothing in the schema, the editor or
 * the seed suggests the content is markdown, and parsing it as such would
 * silently reinterpret an author's `*` or `#` as syntax — plus pull a parser
 * and an HTML sanitiser into a change about paragraph spacing.
 */

/**
 * A blank line — one that holds nothing but whitespace — is the paragraph
 * break. Two or more in a row separate the same two paragraphs as one does,
 * so runs collapse rather than producing empty blocks.
 *
 * `\r\n` is matched explicitly because a textarea submitted by a browser
 * normalises its value to CRLF, so content written on any platform can arrive
 * with carriage returns in it.
 */
const PARAGRAPH_BREAK = /(?:\r?\n[ \t]*){2,}/;

/**
 * Splits `content` into paragraph strings.
 *
 * Single newlines are preserved inside each paragraph — the page renders them
 * with `whitespace-pre-wrap`, so a deliberate line break (an address, a line
 * of verse) survives without becoming a paragraph of its own.
 *
 * Returns an empty array for content that is absent or entirely whitespace, so
 * the caller has one condition to branch on rather than two. A caller that
 * rendered the array without checking would produce nothing at all, which is
 * the safe direction: an empty `<p>` in the middle of a post is a rendering
 * bug that reads as content loss.
 */
export function toParagraphs(content: string | null | undefined): string[] {
  if (!content) return [];

  return content
    .split(PARAGRAPH_BREAK)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);
}
