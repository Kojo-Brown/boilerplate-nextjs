"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { applyResolutions } from "@/lib/concurrency/post-conflict";
import type {
  EditableFields,
  EditableFieldName,
  MergeResult,
  Resolution,
} from "@/lib/concurrency/post-conflict";

/**
 * What the editor shows when a save comes back `conflict`.
 *
 * The panel exists because detection on its own is not a feature. A save that
 * fails with "somebody else changed this post" and no more leaves the author
 * with two documents, one of them in a database they cannot see, and asks them
 * to reconcile the pair from memory. What they need is the other version, next
 * to theirs, field by field, and one decision per field that actually differs.
 *
 * The three-way comparison in `@/lib/concurrency/post-conflict` is what keeps
 * that list short: fields only this browser changed are kept, fields only the
 * other writer changed are taken, and the panel asks about what is left. Most
 * real conflicts — one person retitles, another rewrites the body — reduce to
 * nothing to ask at all.
 *
 * ## Why applying a resolution does not save
 *
 * "Save merged version" would be one click fewer and the wrong shape. A merge
 * is a document neither person wrote, assembled a moment ago from choices made
 * in a hurry; writing it straight back over the row the other author is
 * possibly still looking at, unseen, is how a conflict-resolution UI turns one
 * lost update into two. So resolving loads the result into the editor, rearms
 * the version it is based on, and hands the author back a normal unsaved draft
 * they can read, edit further, and save with the button they already use.
 */

const FIELD_LABELS: Record<EditableFieldName, string> = {
  title: "Title",
  content: "Content",
};

export function ConflictPanel({
  merge,
  theirVersion,
  onResolve,
}: {
  merge: MergeResult;
  /** The version the resolved draft will be based on. */
  theirVersion: number;
  /** Loads the resolved values into the editor, based on `theirVersion`. */
  onResolve: (values: EditableFields) => void;
}) {
  /**
   * One choice per conflicted field, defaulting to this browser's text.
   *
   * The default matches `applyResolutions`, and it is the same argument: the
   * other version is in the database and survives not being chosen, while the
   * draft here exists in one tab and does not. A default has to fall somewhere,
   * so it falls on the value that cannot be recovered any other way.
   */
  const [choices, setChoices] = useState<
    Partial<Record<EditableFieldName, Resolution>>
  >({});

  function choose(field: EditableFieldName, resolution: Resolution) {
    setChoices((current) => ({ ...current, [field]: resolution }));
  }

  return (
    <section
      aria-labelledby="conflict-heading"
      data-testid="conflict-panel"
      className="flex flex-col gap-4 rounded-md border border-yellow-300 bg-yellow-50 p-4 dark:border-yellow-900/60 dark:bg-yellow-950/30"
    >
      <div className="flex flex-col gap-1">
        {/* `role="alert"` on the heading rather than the section: the whole
            panel as one live region would have a screen reader read every
            version of every field before the author could reach the controls. */}
        <h3
          id="conflict-heading"
          role="alert"
          className="text-sm font-semibold"
        >
          This post changed while you were editing
        </h3>
        <p className="text-xs" style={{ color: "var(--muted-foreground)" }}>
          {merge.conflicts.length === 0
            ? "Nothing you edited was touched, so your changes and theirs can both be kept."
            : `Choose what to keep for ${merge.conflicts.length === 1 ? "one field" : `${String(merge.conflicts.length)} fields`}. Nothing is saved until you press Save changes.`}
        </p>
      </div>

      {merge.taken.length > 0 && (
        <p data-testid="conflict-taken" className="text-xs">
          Keeping their{" "}
          {merge.taken
            .map((field) => FIELD_LABELS[field].toLowerCase())
            .join(" and ")}
          , which you had not edited.
        </p>
      )}

      {merge.conflicts.map((conflict) => {
        const choice = choices[conflict.field] ?? "mine";

        return (
          <fieldset
            key={conflict.field}
            className="flex flex-col gap-2"
            data-testid={`conflict-${conflict.field}`}
          >
            <legend className="text-xs font-medium">
              {FIELD_LABELS[conflict.field]}
            </legend>

            <ConflictChoice
              field={conflict.field}
              side="mine"
              label="Keep mine"
              value={conflict.mine}
              checked={choice === "mine"}
              onSelect={choose}
            />
            <ConflictChoice
              field={conflict.field}
              side="theirs"
              label="Use theirs"
              value={conflict.theirs}
              checked={choice === "theirs"}
              onSelect={choose}
            />
          </fieldset>
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          onClick={() => onResolve(applyResolutions(merge, choices))}
        >
          Apply to editor
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          onClick={() =>
            // Everything from their row, including the fields this browser
            // changed. The one honest way to say "I was wrong, start from
            // theirs" — and the reason it is a separate button rather than
            // "Use theirs" on every field is that it must stay one decision
            // however many fields are in conflict.
            onResolve(theirFields(merge))
          }
        >
          Discard my changes
        </Button>
        <span className="text-xs" style={{ color: "var(--muted-foreground)" }}>
          Based on version {theirVersion}
        </span>
      </div>
    </section>
  );
}

/**
 * Their side of every conflicted field, over the auto-merged values.
 *
 * `merge.merged` already holds their text for the fields this browser did not
 * touch, so overwriting only the conflicts is enough to reconstruct their row —
 * without the panel having to be handed a second copy of it.
 */
function theirFields(merge: MergeResult): EditableFields {
  return applyResolutions(
    merge,
    Object.fromEntries(
      merge.conflicts.map((conflict) => [conflict.field, "theirs" as const]),
    ),
  );
}

function ConflictChoice({
  field,
  side,
  label,
  value,
  checked,
  onSelect,
}: {
  field: EditableFieldName;
  side: Resolution;
  label: string;
  value: string | null;
  checked: boolean;
  onSelect: (field: EditableFieldName, side: Resolution) => void;
}) {
  const id = `conflict-${field}-${side}`;

  return (
    <label
      htmlFor={id}
      className="flex cursor-pointer items-start gap-2 rounded-md border bg-[var(--background)] p-2"
    >
      <input
        type="radio"
        id={id}
        name={`conflict-${field}`}
        checked={checked}
        onChange={() => onSelect(field, side)}
        className="mt-0.5"
      />
      <span className="flex min-w-0 flex-col gap-1">
        <span className="text-xs font-medium">{label}</span>
        {/* `whitespace-pre-wrap` because the body is plain text whose blank
            lines are its paragraphs — collapsing them here would show two
            versions that look identical and differ. */}
        <span
          className="max-h-32 overflow-y-auto text-xs break-words whitespace-pre-wrap"
          style={{ color: "var(--muted-foreground)" }}
        >
          {value === null ? "(empty)" : value}
        </span>
      </span>
    </label>
  );
}
