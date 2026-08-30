// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { togglePublishAction, updatePostAction } from "@/actions/posts";
import { toast } from "@/lib/toast";
import type { ActionResult } from "@/lib/actions/result";
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
};

function saved(
  overrides: Partial<EditablePost> = {},
): ActionResult<EditablePost> {
  return { success: true, data: { ...post, ...overrides } };
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
    const save = deferred<ActionResult<EditablePost>>();
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
    const save = deferred<ActionResult<EditablePost>>();
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
    const save = deferred<ActionResult<EditablePost>>();
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
    const save = deferred<ActionResult<EditablePost>>();
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
