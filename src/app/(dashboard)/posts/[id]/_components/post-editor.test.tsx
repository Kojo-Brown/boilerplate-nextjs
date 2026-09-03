// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { togglePublishAction, updatePostAction } from "@/actions/posts";
import { toast } from "@/lib/toast";
import type { ActionResult } from "@/lib/actions/result";
import type { SavePostOutcome } from "@/lib/concurrency/post-conflict";
import type { EditablePost } from "@/lib/dal/posts";
import { PostEditor } from "./post-editor";

vi.mock("@/actions/posts", () => ({
  updatePostAction: vi.fn(),
  togglePublishAction: vi.fn(),
}));

vi.mock("@/lib/toast", () => ({
  toast: { success: vi.fn(), error: vi.fn() },
  toastActionError: vi.fn(),
}));

const mockUpdate = vi.mocked(updatePostAction);
const mockToggle = vi.mocked(togglePublishAction);

/**
 * A promise the test resolves by hand.
 *
 * Every assertion here is about *when* something is on the screen — an
 * optimistic value exists only while the transition that applied it is pending
 * — so the action has to stay in flight for as long as the test needs to look
 * at it. A mock that resolves immediately would make the pending frame
 * unobservable and every one of these tests vacuous.
 */
function deferred<T>() {
  let settle!: (value: T) => void;
  const promise = new Promise<T>((resolve) => {
    settle = resolve;
  });
  return { promise, settle };
}

const post: EditablePost = {
  id: "post-1",
  title: "Original title",
  content: "Original body",
  published: false,
  updatedAt: new Date("2026-01-01T00:00:00Z"),
  version: 3,
};

/**
 * A successful save, at the version the write would have produced.
 *
 * `version + 1` rather than `post.version`: the row the server hands back has
 * been written, and a fixture that returned the version the editor sent would
 * be describing a save that did not happen — which is also the state the
 * component uses to decide whether its draft is still current.
 */
function saved(
  overrides: Partial<EditablePost> = {},
): ActionResult<SavePostOutcome> {
  return {
    success: true,
    data: {
      status: "saved",
      post: { ...post, version: post.version + 1, ...overrides },
    },
  };
}

/** A save rejected because the row moved, carrying the row it found. */
function conflicted(
  theirs: Partial<EditablePost> = {},
): ActionResult<SavePostOutcome> {
  return {
    success: true,
    data: {
      status: "conflict",
      current: { ...post, version: post.version + 1, ...theirs },
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

function heading() {
  return screen.getByTestId("post-heading");
}

function publishState() {
  return screen.getByTestId("publish-state");
}

describe("PostEditor — saving", () => {
  it("shows the new title before the server has agreed to it", async () => {
    const save = deferred<ActionResult<SavePostOutcome>>();
    mockUpdate.mockReturnValue(save.promise);

    render(<PostEditor post={post} />);
    expect(heading()).toHaveTextContent("Original title");

    await userEvent.clear(screen.getByLabelText(/title/i));
    await userEvent.type(screen.getByLabelText(/title/i), "Edited title");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(heading()).toHaveTextContent("Edited title"));
    // Still in flight: nothing has come back from the server yet.
    expect(mockUpdate).toHaveBeenCalledOnce();

    // Settled inside `act` so React's re-render from the resolution happens
    // before the test ends; otherwise it lands after teardown and React says so.
    await act(async () => save.settle(saved({ title: "Edited title" })));
  });

  it("rolls the heading back when the save is rejected, and keeps the draft", async () => {
    const save = deferred<ActionResult<SavePostOutcome>>();
    mockUpdate.mockReturnValue(save.promise);

    render(<PostEditor post={post} />);

    await userEvent.clear(screen.getByLabelText(/title/i));
    await userEvent.type(screen.getByLabelText(/title/i), "Edited title");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => expect(heading()).toHaveTextContent("Edited title"));

    save.settle({ success: false, error: "You can only edit your own posts." });

    // The rollback: `post` never changed, so discarding the optimistic value
    // puts the stored title back. Nothing in the component undoes anything.
    await waitFor(() => expect(heading()).toHaveTextContent("Original title"));
    expect(
      screen.getByText("You can only edit your own posts."),
    ).toBeInTheDocument();
    // …while the rejected draft stays in the input, which is the half React
    // would have thrown away had the form been uncontrolled.
    expect(screen.getByLabelText(/title/i)).toHaveValue("Edited title");
  });

  it("keeps the new title once the server row it is rendered from catches up", async () => {
    mockUpdate.mockResolvedValue(saved({ title: "Edited title" }));

    const { rerender } = render(<PostEditor post={post} />);

    await userEvent.clear(screen.getByLabelText(/title/i));
    await userEvent.type(screen.getByLabelText(/title/i), "Edited title");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Post saved"),
    );

    // What `invalidate()` buys: the Server Component re-renders with the saved
    // row, so the discarded optimistic value is replaced by an identical real
    // one and the heading never flickers.
    rerender(<PostEditor post={{ ...post, title: "Edited title" }} />);
    expect(heading()).toHaveTextContent("Edited title");
  });

  it("submits the whole payload, including the id, as form data", async () => {
    mockUpdate.mockResolvedValue(saved());

    render(<PostEditor post={post} />);

    await userEvent.clear(screen.getByLabelText(/content/i));
    await userEvent.type(screen.getByLabelText(/content/i), "New body");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledOnce());
    const formData = mockUpdate.mock.calls[0]?.[1];
    expect(formData?.get("postId")).toBe("post-1");
    expect(formData?.get("title")).toBe("Original title");
    expect(formData?.get("content")).toBe("New body");
    // The version the draft was made from. Without it the save has no way to
    // notice that somebody else has written the row since it was loaded.
    expect(formData?.get("expectedVersion")).toBe("3");
  });

  it("renders a schema failure under the field it names", async () => {
    mockUpdate.mockResolvedValue({
      success: false,
      error: "Title is required",
      fieldErrors: { title: ["Title is required"] },
    });

    render(<PostEditor post={post} />);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const field = await screen.findByLabelText(/title/i);
    await waitFor(() =>
      expect(field).toHaveAccessibleDescription("Title is required"),
    );
    // A field error is not also a toast: it is already rendered where it
    // applies, and a whole-form alert would be a second copy of it.
    expect(toast.error).not.toHaveBeenCalled();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("does not blank the heading for a submission that cannot succeed", async () => {
    const save = deferred<ActionResult<SavePostOutcome>>();
    mockUpdate.mockReturnValue(save.promise);

    render(<PostEditor post={post} />);
    await userEvent.clear(screen.getByLabelText(/title/i));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    // An empty title is going to fail its schema. Optimistically rendering it
    // would replace the heading with nothing for the length of a round trip.
    expect(heading()).toHaveTextContent("Original title");

    await act(async () =>
      save.settle({
        success: false,
        error: "Title is required",
        fieldErrors: { title: ["Title is required"] },
      }),
    );
  });

  it("disables the controls while a save is in flight", async () => {
    const save = deferred<ActionResult<SavePostOutcome>>();
    mockUpdate.mockReturnValue(save.promise);

    render(<PostEditor post={post} />);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const submit = await screen.findByRole("button", { name: "Saving…" });
    expect(submit).toBeDisabled();
    // Both mutations write the same row, so one must not be startable while
    // the other is outstanding.
    expect(screen.getByRole("button", { name: "Publish" })).toBeDisabled();

    save.settle(saved());
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeEnabled(),
    );
  });
});

describe("PostEditor — publishing", () => {
  it("flips the pill before the server has agreed to it", async () => {
    const toggle = deferred<ActionResult<{ published: boolean }>>();
    mockToggle.mockReturnValue(
      toggle.promise as ReturnType<typeof togglePublishAction>,
    );

    render(<PostEditor post={post} />);
    expect(publishState()).toHaveTextContent("Draft");

    await userEvent.click(screen.getByRole("button", { name: "Publish" }));

    await waitFor(() => expect(publishState()).toHaveTextContent("Published"));

    await act(async () =>
      toggle.settle({ success: true, data: { published: true } }),
    );
  });

  it("rolls the pill back when the toggle is rejected", async () => {
    const toggle = deferred<ActionResult<{ published: boolean }>>();
    mockToggle.mockReturnValue(
      toggle.promise as ReturnType<typeof togglePublishAction>,
    );

    render(<PostEditor post={post} />);
    await userEvent.click(screen.getByRole("button", { name: "Publish" }));
    await waitFor(() => expect(publishState()).toHaveTextContent("Published"));

    toggle.settle({ success: false, error: "Post not found." });

    await waitFor(() => expect(publishState()).toHaveTextContent("Draft"));
    expect(toast.error).toHaveBeenCalledWith("Post not found.");
  });

  it("reports which direction the toggle went", async () => {
    mockToggle.mockResolvedValue({
      success: true,
      data: { published: false },
    } as Awaited<ReturnType<typeof togglePublishAction>>);

    render(<PostEditor post={{ ...post, published: true }} />);
    await userEvent.click(screen.getByRole("button", { name: "Unpublish" }));

    await waitFor(() =>
      expect(toast.success).toHaveBeenCalledWith("Post reverted to draft"),
    );
  });
});

/**
 * What the editor does when the save comes back `conflict`.
 *
 * A conflict arrives as a *successful* result carrying the row the save found
 * instead of the one it expected — see `SavePostOutcome` — so these tests hand
 * the mock `conflicted(...)` rather than a failure. The row it carries is the
 * other writer's, and every assertion below is about the three-way comparison
 * between it, the draft in the browser, and the row this editor loaded.
 */
describe("PostEditor — conflicts", () => {
  const titleInput = () => screen.getByRole("textbox", { name: /^title/i });
  const contentInput = () => screen.getByRole("textbox", { name: /content/i });
  const expectedVersion = () =>
    screen.getByTestId("expected-version").getAttribute("value");

  it("takes their change to a field this browser never edited, without asking", async () => {
    mockUpdate.mockResolvedValue(conflicted({ title: "Their title" }));

    render(<PostEditor post={post} />);
    await userEvent.clear(contentInput());
    await userEvent.type(contentInput(), "My body");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const panel = await screen.findByTestId("conflict-panel");
    // Nothing to decide: they moved the title, this browser moved the body, and
    // the two edits do not touch. A two-way comparison would have called this a
    // conflict and made the author choose which of the two to throw away.
    expect(within(panel).queryByRole("radio")).not.toBeInTheDocument();
    expect(screen.getByTestId("conflict-taken")).toHaveTextContent(
      "Keeping their title",
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Apply to editor" }),
    );

    expect(titleInput()).toHaveValue("Their title");
    expect(contentInput()).toHaveValue("My body");
    expect(screen.queryByTestId("conflict-panel")).not.toBeInTheDocument();
  });

  it("asks about a field both sides changed, and keeps the chosen side", async () => {
    mockUpdate.mockResolvedValue(conflicted({ title: "Their title" }));

    render(<PostEditor post={post} />);
    await userEvent.clear(titleInput());
    await userEvent.type(titleInput(), "My title");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const field = await screen.findByTestId("conflict-title");
    // The author's own text is preselected: the other version is in the
    // database and survives not being picked, this one exists in one tab.
    expect(
      within(field).getByRole("radio", { name: /Keep mine/ }),
    ).toBeChecked();

    await userEvent.click(
      within(field).getByRole("radio", { name: /Use theirs/ }),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Apply to editor" }),
    );

    expect(titleInput()).toHaveValue("Their title");
  });

  it("rebases the draft, so the next save is not rejected by the same check", async () => {
    mockUpdate.mockResolvedValue(conflicted({ title: "Their title" }));

    render(<PostEditor post={post} />);
    await userEvent.clear(contentInput());
    await userEvent.type(contentInput(), "My body");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByTestId("conflict-panel");
    expect(expectedVersion()).toBe("3");

    await userEvent.click(
      screen.getByRole("button", { name: "Apply to editor" }),
    );

    // The resolution was made against version 4, so that is what the next save
    // claims to have read. Left at 3 it would conflict with the same row
    // forever, and the panel would be a loop rather than a way out.
    expect(expectedVersion()).toBe("4");

    mockUpdate.mockResolvedValue(saved({ version: 5 }));
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(mockUpdate).toHaveBeenCalledTimes(2));
    expect(mockUpdate.mock.calls[1]?.[1].get("expectedVersion")).toBe("4");
  });

  it("loads their whole row when the author discards their changes", async () => {
    mockUpdate.mockResolvedValue(
      conflicted({ title: "Their title", content: "Their body" }),
    );

    render(<PostEditor post={post} />);
    await userEvent.clear(titleInput());
    await userEvent.type(titleInput(), "My title");
    await userEvent.clear(contentInput());
    await userEvent.type(contentInput(), "My body");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByTestId("conflict-panel");
    await userEvent.click(
      screen.getByRole("button", { name: "Discard my changes" }),
    );

    expect(titleInput()).toHaveValue("Their title");
    expect(contentInput()).toHaveValue("Their body");
    expect(screen.queryByTestId("conflict-panel")).not.toBeInTheDocument();
  });

  it("does not report a conflicted save as saved", async () => {
    mockUpdate.mockResolvedValue(conflicted({ title: "Their title" }));

    render(<PostEditor post={post} />);
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByTestId("conflict-panel");
    // Nothing was written. A "Post saved" toast beside a panel explaining that
    // the save did not happen is the worst of both messages.
    expect(toast.success).not.toHaveBeenCalled();
  });

  it("reopens for a third writer who lands while the panel is open", async () => {
    mockUpdate.mockResolvedValue(conflicted({ title: "Their title" }));

    render(<PostEditor post={post} />);
    await userEvent.clear(titleInput());
    await userEvent.type(titleInput(), "My title");
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await screen.findByTestId("conflict-panel");
    await userEvent.click(
      screen.getByRole("button", { name: "Apply to editor" }),
    );
    expect(screen.queryByTestId("conflict-panel")).not.toBeInTheDocument();

    // The resolved draft is saved against version 4 — and somebody has written
    // version 5 in the meantime. Adopting one row must not silence the next
    // conflict, which is the failure a `dismissed` boolean would have.
    mockUpdate.mockResolvedValue(
      conflicted({ title: "A third title", version: 5 }),
    );
    await userEvent.click(screen.getByRole("button", { name: "Save changes" }));

    const panel = await screen.findByTestId("conflict-panel");
    expect(within(panel).getByText(/A third title/)).toBeInTheDocument();
  });
});
