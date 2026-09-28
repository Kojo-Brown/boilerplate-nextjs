// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageUpload } from "@/components/ui/image-upload";
import * as uploadActions from "@/actions/upload";
import {
  GIF89_HEADER,
  HTML_DOCUMENT,
  PNG_HEADER,
  SVG_DOCUMENT,
} from "@/test/image-bytes";

vi.mock("@/actions/upload", () => ({
  getPresignedUploadUrlAction: vi.fn(),
  finalizeUploadAction: vi.fn(),
}));

// jsdom does not implement the object-URL APIs at all, so there is nothing for
// `vi.spyOn` to replace — they have to be installed on URL first. Defined as
// configurable so `vi.restoreAllMocks()` and later redefinitions still work.
beforeEach(() => {
  // Call history, not implementations. Several assertions below are of the form
  // "finalize was never reached", which a previous test's call would satisfy —
  // and did: the PUT-failure case saw four calls from earlier tests and passed
  // for the wrong reason until this line existed.
  vi.clearAllMocks();

  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:http://localhost/test-preview"),
    writable: true,
    configurable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    writable: true,
    configurable: true,
  });
});

/**
 * A file whose *bytes* match its declared type.
 *
 * These used to be `"x".repeat(size)` with a MIME type attached, which no longer
 * reaches the network: the component sniffs the header before it uploads
 * anything, so a file full of `x` declared as a PNG is now refused — correctly,
 * and for the reason this item exists. Padding to `size` keeps the size-limit
 * case honest without making the fixture a real image.
 */
function makeFile(
  name = "photo.png",
  type = "image/png",
  size = 1024,
  header: Uint8Array = PNG_HEADER,
) {
  const padding = new Uint8Array(Math.max(size - header.length, 0));
  const file = new File([header as BlobPart, padding as BlobPart], name, {
    type,
  });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

function fileInput(): HTMLInputElement {
  return document.querySelector('input[type="file"]') as HTMLInputElement;
}

/** An XHR whose `load` fires on the next tick with a 2xx. */
function stubXhr() {
  const xhrMock = {
    upload: { addEventListener: vi.fn() },
    addEventListener: vi.fn((event: string, cb: () => void) => {
      if (event === "load") setTimeout(cb, 0);
    }),
    open: vi.fn(),
    setRequestHeader: vi.fn(),
    send: vi.fn(),
    status: 200,
  };
  vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(
    () => xhrMock as unknown as XMLHttpRequest,
  );
  return xhrMock;
}

const PRESIGNED = {
  success: true as const,
  data: {
    uploadUrl: "https://bucket.s3.amazonaws.com/quarantine/key?presigned",
    key: "quarantine/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png",
  },
};

const FINALIZED = {
  success: true as const,
  data: {
    publicUrl:
      "https://bucket.s3.amazonaws.com/uploads/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png",
    key: "uploads/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png",
    type: "image/png",
    sizeBytes: 1024,
    scanned: true,
  },
};

function happyPath() {
  vi.mocked(uploadActions.getPresignedUploadUrlAction).mockResolvedValue(
    PRESIGNED,
  );
  vi.mocked(uploadActions.finalizeUploadAction).mockResolvedValue(FINALIZED);
  return stubXhr();
}

describe("ImageUpload", () => {
  it("renders upload area in idle state", () => {
    render(<ImageUpload />);
    expect(screen.getByText("Click to upload")).toBeInTheDocument();
    expect(screen.getByText(/JPEG, PNG, WebP/)).toBeInTheDocument();
  });

  it("no longer offers SVG", () => {
    render(<ImageUpload />);
    expect(screen.queryByText(/SVG/)).not.toBeInTheDocument();
    expect(fileInput().accept).not.toContain("svg");
  });

  it("is disabled when disabled prop is true", () => {
    render(<ImageUpload disabled />);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
  });

  it("shows error for disallowed MIME type", async () => {
    render(<ImageUpload />);

    fireEvent.change(fileInput(), {
      target: { files: [makeFile("doc.pdf", "application/pdf")] },
    });

    await waitFor(() => {
      expect(screen.getByText(/File type not allowed/)).toBeInTheDocument();
    });
  });

  it("shows error for file exceeding size limit", async () => {
    render(<ImageUpload />);

    fireEvent.change(fileInput(), {
      target: { files: [makeFile("huge.png", "image/png", 6 * 1024 * 1024)] },
    });

    await waitFor(() => {
      expect(screen.getByText(/exceeds the 5 MB limit/)).toBeInTheDocument();
    });
  });

  it("refuses a file whose bytes are not the type it is named as", async () => {
    // The same sniff the server performs, run before anything is uploaded. Not a
    // security control — it is in the caller's own browser — but it turns the
    // commonest honest mistake into an immediate message instead of a slow upload
    // followed by a rejection.
    const onError = vi.fn();
    render(<ImageUpload onUploadError={onError} />);

    fireEvent.change(fileInput(), {
      target: {
        files: [makeFile("renamed.png", "image/png", 64, GIF89_HEADER)],
      },
    });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        expect.stringContaining("image/gif"),
      );
    });

    expect(uploadActions.getPresignedUploadUrlAction).not.toHaveBeenCalled();
  });

  it("refuses an HTML document renamed to .png without a round trip", async () => {
    render(<ImageUpload />);

    fireEvent.change(fileInput(), {
      target: {
        files: [makeFile("payload.png", "image/png", 64, HTML_DOCUMENT)],
      },
    });

    await waitFor(() => {
      expect(
        screen.getByText(/contents are not a JPEG, PNG, WebP or GIF/),
      ).toBeInTheDocument();
    });

    expect(uploadActions.getPresignedUploadUrlAction).not.toHaveBeenCalled();
  });

  it("refuses an SVG, which the type check catches before the sniff", async () => {
    render(<ImageUpload />);

    fireEvent.change(fileInput(), {
      target: {
        files: [makeFile("logo.svg", "image/svg+xml", 128, SVG_DOCUMENT)],
      },
    });

    await waitFor(() => {
      expect(screen.getByText(/File type not allowed/)).toBeInTheDocument();
    });
  });

  it("calls onUploadError with server error message", async () => {
    vi.mocked(uploadActions.getPresignedUploadUrlAction).mockResolvedValue({
      success: false,
      error: "File uploads are not configured on this server.",
    });

    const onError = vi.fn();
    render(<ImageUpload onUploadError={onError} />);

    fireEvent.change(fileInput(), { target: { files: [makeFile()] } });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        "File uploads are not configured on this server.",
      );
    });
  });

  it("shows done state and calls onUploadComplete after successful upload", async () => {
    happyPath();

    const onComplete = vi.fn();
    render(<ImageUpload onUploadComplete={onComplete} />);

    fireEvent.change(fileInput(), { target: { files: [makeFile()] } });

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith(FINALIZED.data.publicUrl);
    });

    expect(screen.getByText("Replace")).toBeInTheDocument();
  });

  it("completes with the URL finalize returned, not one it assembled", async () => {
    // The presign hands back no readable URL at all, so there is nothing for the
    // component to show until the server has verified the object.
    happyPath();

    const onComplete = vi.fn();
    render(<ImageUpload onUploadComplete={onComplete} />);

    fireEvent.change(fileInput(), { target: { files: [makeFile()] } });

    await waitFor(() => expect(onComplete).toHaveBeenCalled());

    expect(onComplete.mock.calls[0]![0]).toContain("/uploads/");
    expect(onComplete.mock.calls[0]![0]).not.toContain("/quarantine/");
  });

  it("finalizes with the key the presign returned and the file's own size", async () => {
    happyPath();
    render(<ImageUpload />);

    fireEvent.change(fileInput(), { target: { files: [makeFile()] } });

    await waitFor(() =>
      expect(uploadActions.finalizeUploadAction).toHaveBeenCalledWith({
        key: PRESIGNED.data.key,
        sizeBytes: 1024,
      }),
    );
  });

  it("surfaces a rejection from finalize", async () => {
    // The upload succeeded and the object was then refused, which is a state the
    // old single-step flow had no way to be in.
    vi.mocked(uploadActions.getPresignedUploadUrlAction).mockResolvedValue(
      PRESIGNED,
    );
    vi.mocked(uploadActions.finalizeUploadAction).mockResolvedValue({
      success: false,
      error: "That file was rejected by a security scan.",
    });
    stubXhr();

    const onError = vi.fn();
    const onComplete = vi.fn();
    render(
      <ImageUpload onUploadComplete={onComplete} onUploadError={onError} />,
    );

    fireEvent.change(fileInput(), { target: { files: [makeFile()] } });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith(
        "That file was rejected by a security scan.",
      );
    });

    expect(onComplete).not.toHaveBeenCalled();
    expect(screen.getByText("Try again")).toBeInTheDocument();
  });

  it("does not finalize an upload whose PUT failed", async () => {
    vi.mocked(uploadActions.getPresignedUploadUrlAction).mockResolvedValue(
      PRESIGNED,
    );
    vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(
      () =>
        ({
          upload: { addEventListener: vi.fn() },
          addEventListener: vi.fn((event: string, cb: () => void) => {
            if (event === "load") setTimeout(cb, 0);
          }),
          open: vi.fn(),
          setRequestHeader: vi.fn(),
          send: vi.fn(),
          status: 403,
        }) as unknown as XMLHttpRequest,
    );

    render(<ImageUpload />);
    fireEvent.change(fileInput(), { target: { files: [makeFile()] } });

    await waitFor(() =>
      expect(screen.getByText("Try again")).toBeInTheDocument(),
    );
    expect(uploadActions.finalizeUploadAction).not.toHaveBeenCalled();
  });

  it("says so when the server accepted the file without scanning it", async () => {
    // Shown rather than only logged: the person looking at the result is entitled
    // to know that no scanner is configured.
    vi.mocked(uploadActions.getPresignedUploadUrlAction).mockResolvedValue(
      PRESIGNED,
    );
    vi.mocked(uploadActions.finalizeUploadAction).mockResolvedValue({
      success: true,
      data: { ...FINALIZED.data, scanned: false },
    });
    stubXhr();

    render(<ImageUpload />);
    fireEvent.change(fileInput(), { target: { files: [makeFile()] } });

    await waitFor(() => screen.getByText("Replace"));
    expect(screen.getByText("Not scanned")).toBeInTheDocument();
  });

  it("says nothing about scanning when the file was scanned", async () => {
    happyPath();
    render(<ImageUpload />);

    fireEvent.change(fileInput(), { target: { files: [makeFile()] } });

    await waitFor(() => screen.getByText("Replace"));
    expect(screen.queryByText("Not scanned")).not.toBeInTheDocument();
  });

  it("resets to idle when Replace is clicked", async () => {
    happyPath();
    render(<ImageUpload />);

    fireEvent.change(fileInput(), { target: { files: [makeFile()] } });

    await waitFor(() => screen.getByText("Replace"));

    await userEvent.click(screen.getByText("Replace"));
    expect(screen.getByText("Click to upload")).toBeInTheDocument();
  });
});
