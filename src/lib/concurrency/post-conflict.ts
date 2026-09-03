/**
 * The three-way comparison behind the editor's conflict-resolution UI, and the
 * shape the save reports a conflict in.
 *
 * `Post.version` (see `prisma/schema.prisma`) turns a lost update into a
 * *detected* one: the save posts the version it read, the `UPDATE` matches on
 * it, and a row somebody else has written since matches nothing. That is the
 * whole guarantee, and on its own it is only half a feature — detection with no
 * resolution is a save button that fails and a document the author has to
 * reconcile by hand, in their head, with the other version on screen.
 *
 * What resolution needs is the observation that a conflict is per *field*, not
 * per row. Three values exist for every field when a save is rejected: the one
 * the editor loaded (`base`), the one in the browser (`mine`), and the one in
 * the database (`theirs`). Comparing all three answers most fields without
 * asking anybody:
 *
 *   | base = mine | base = theirs | answer                                |
 *   | ----------- | ------------- | ------------------------------------- |
 *   | yes         | yes           | nobody touched it — keep it           |
 *   | yes         | no            | only they changed it — take theirs    |
 *   | no          | yes           | only I changed it — keep mine         |
 *   | no          | no            | both changed it — ask, unless equal   |
 *
 * The row on the third line is the one that matters in practice and the one a
 * two-way comparison gets wrong. If they retitled the post while I rewrote the
 * body, "keep mine" silently reverts their title and "use theirs" silently
 * throws away my body — and a UI offering only those two makes the author pick
 * which colleague's work to destroy. With `base` in hand, neither field is a
 * conflict at all and the merge is exact.
 *
 * Kept pure and free of React so the rule above can be tested as a table rather
 * than through a component, and so the same comparison is available to anything
 * else that grows a conflicting write later.
 */
import type { EditablePost } from "@/lib/dal/posts";

/**
 * The fields the editor writes, and the only ones `Post.version` guards.
 *
 * `published` is not among them on purpose: `togglePublishAction` is the only
 * writer of that column and it writes nothing else, so the two mutations cannot
 * lose each other's work. See the note on `updatePostAction`.
 */
export interface EditableFields {
  title: string;
  content: string | null;
}

export const EDITABLE_FIELDS = ["title", "content"] as const;

export type EditableFieldName = (typeof EDITABLE_FIELDS)[number];

/**
 * What a save did.
 *
 * A conflict is an *outcome*, not a failure, which is why this is the action's
 * success payload rather than an `ActionError`. `ActionResult`'s failure half
 * carries a sentence and nothing else — and a conflict the UI can do anything
 * about has to arrive with the other writer's row attached. Modelling it as an
 * error would mean either inventing a third channel on every action's result or
 * serialising a row into a string for the client to parse back out.
 */
export type SavePostOutcome =
  | { status: "saved"; post: EditablePost }
  | { status: "conflict"; current: EditablePost };

/** A field both sides changed, to different values. */
export interface FieldConflict {
  field: EditableFieldName;
  /** The value the editor loaded — what both sides started from. */
  base: string | null;
  /** The value in this browser. */
  mine: string | null;
  /** The value in the database, written by the other save. */
  theirs: string | null;
}

export interface MergeResult {
  /**
   * The values a save would write once the conflicts below are decided.
   *
   * Conflicted fields sit here at `mine`, so this is a complete set of values
   * at every point rather than a partial one with holes for the caller to
   * remember to fill. `applyResolutions` is what replaces them with the
   * author's choices; reading `merged` while `conflicts` is non-empty and
   * saving it is "keep mine for everything", which is a decision the UI is
   * allowed to offer but never one it should take silently.
   */
  merged: EditableFields;
  /** Fields that need the author to choose. Empty means the merge is exact. */
  conflicts: FieldConflict[];
  /**
   * Fields resolved to the other writer's value without asking, because this
   * browser had not touched them.
   *
   * Reported rather than merged silently: the author is about to save a
   * document containing text they never typed, and a merge that does not say so
   * is indistinguishable from one that dropped it.
   */
  taken: EditableFieldName[];
}

/**
 * Normalises the one field with two spellings of "empty".
 *
 * `content` is nullable in the database, an emptied `<textarea>` submits `""`,
 * and `updatePostSchema` stores that as `null`. So the same absence arrives as
 * `""` from the browser and `null` from the database, and a comparison that did
 * not fold them would report a conflict between a value and itself — on the
 * field most likely to be empty.
 */
function normalise(value: string | null | undefined): string | null {
  return value === "" || value === undefined ? null : value;
}

function fieldValue(
  fields: Partial<EditableFields>,
  field: EditableFieldName,
): string | null {
  return field === "title" ? (fields.title ?? null) : normalise(fields.content);
}

/**
 * Compares the three versions of a row field by field.
 *
 * `mine` is the browser's draft, `theirs` the row the rejected save found in
 * the database, and `base` the row the draft was made from — which is *not*
 * "the row as it was a moment ago": it has to be the version the editor
 * actually loaded, or the comparison cannot tell "I changed this" from "I never
 * touched it". That is why the editor keeps its basis explicitly instead of
 * reading it back off the latest props.
 */
export function mergeEditable(args: {
  base: Partial<EditableFields>;
  mine: Partial<EditableFields>;
  theirs: Partial<EditableFields>;
}): MergeResult {
  const merged: EditableFields = { title: "", content: null };
  const conflicts: FieldConflict[] = [];
  const taken: EditableFieldName[] = [];

  for (const field of EDITABLE_FIELDS) {
    const base = fieldValue(args.base, field);
    const mine = fieldValue(args.mine, field);
    const theirs = fieldValue(args.theirs, field);

    const iChanged = mine !== base;
    const theyChanged = theirs !== base;

    // `mine !== theirs` is what folds convergence away: two people who made the
    // same edit have nothing to decide, and a UI asked to render that conflict
    // would offer a choice between two identical values.
    if (iChanged && theyChanged && mine !== theirs) {
      conflicts.push({ field, base, mine, theirs });
      assign(merged, field, mine);
      continue;
    }

    if (!iChanged && theyChanged) {
      taken.push(field);
      assign(merged, field, theirs);
      continue;
    }

    assign(merged, field, mine);
  }

  return { merged, conflicts, taken };
}

function assign(
  fields: EditableFields,
  field: EditableFieldName,
  value: string | null,
): void {
  if (field === "title") {
    fields.title = value ?? "";
    return;
  }
  fields.content = value;
}

/** Which side of one conflicted field the author kept. */
export type Resolution = "mine" | "theirs";

/**
 * Applies the author's per-field choices to a merge.
 *
 * A missing choice falls back to `"mine"`, and that default is the safe one
 * rather than the polite one: the other writer's text is in the database and
 * survives being passed over, while the draft in this browser exists nowhere
 * else and is gone the moment it is overwritten. A UI that forgets to record a
 * choice therefore loses nothing recoverable.
 */
export function applyResolutions(
  merge: MergeResult,
  choices: Partial<Record<EditableFieldName, Resolution>>,
): EditableFields {
  const resolved: EditableFields = { ...merge.merged };

  for (const conflict of merge.conflicts) {
    const choice = choices[conflict.field] ?? "mine";
    assign(
      resolved,
      conflict.field,
      choice === "theirs" ? conflict.theirs : conflict.mine,
    );
  }

  return resolved;
}
