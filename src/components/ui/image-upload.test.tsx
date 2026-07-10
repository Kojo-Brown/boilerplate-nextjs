// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageUpload } from "@/components/ui/image-upload";
import * as uploadActions from "@/actions/upload";

vi.mock("@/actions/upload", () => ({
  getPresignedUploadUrlAction: vi.fn(),
}));

// Stub URL.createObjectURL / revokeObjectURL
beforeEach(() => {
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:http://localhost/test-preview");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
});

function makeFile(name = "photo.png", type = "image/png", size = 1024) {
  const file = new File(["x".repeat(size)], name, { type });
  Object.defineProperty(file, "size", { value: size });
  return file;
}

describe("ImageUpload", () => {
  it("renders upload area in idle state", () => {
    render(<ImageUpload />);
    expect(screen.getByText("Click to upload")).toBeInTheDocument();
    expect(screen.getByText(/JPEG, PNG, WebP/)).toBeInTheDocument();
  });

  it("is disabled when disabled prop is true", () => {
    render(<ImageUpload disabled />);
    const btn = screen.getByRole("button");
    expect(btn).toBeDisabled();
  });

  it("shows error for disallowed MIME type", async () => {
    render(<ImageUpload />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    const badFile = makeFile("doc.pdf", "application/pdf");
    fireEvent.change(input, { target: { files: [badFile] } });

    await waitFor(() => {
      expect(screen.getByText(/File type not allowed/)).toBeInTheDocument();
    });
  });

  it("shows error for file exceeding size limit", async () => {
    render(<ImageUpload />);
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;

    const bigFile = makeFile("huge.png", "image/png", 6 * 1024 * 1024);
    fireEvent.change(input, { target: { files: [bigFile] } });

    await waitFor(() => {
      expect(screen.getByText(/exceeds the 5 MB limit/)).toBeInTheDocument();
    });
  });

  it("calls onUploadError with server error message", async () => {
    vi.mocked(uploadActions.getPresignedUploadUrlAction).mockResolvedValue({
      success: false,
      error: "File uploads are not configured on this server.",
    });

    const onError = vi.fn();
    render(<ImageUpload onUploadError={onError} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile()] } });

    await waitFor(() => {
      expect(onError).toHaveBeenCalledWith("File uploads are not configured on this server.");
    });
  });

  it("shows done state and calls onUploadComplete after successful upload", async () => {
    vi.mocked(uploadActions.getPresignedUploadUrlAction).mockResolvedValue({
      success: true,
      data: {
        uploadUrl: "https://bucket.s3.amazonaws.com/key?presigned",
        publicUrl: "https://bucket.s3.amazonaws.com/uploads/user/123.png",
        key: "uploads/user/123.png",
      },
    });

    // Stub XHR
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
    vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => xhrMock as unknown as XMLHttpRequest);

    const onComplete = vi.fn();
    render(<ImageUpload onUploadComplete={onComplete} />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile()] } });

    await waitFor(() => {
      expect(onComplete).toHaveBeenCalledWith(
        "https://bucket.s3.amazonaws.com/uploads/user/123.png",
      );
    });

    expect(screen.getByText("Replace")).toBeInTheDocument();
  });

  it("resets to idle when Replace is clicked", async () => {
    vi.mocked(uploadActions.getPresignedUploadUrlAction).mockResolvedValue({
      success: true,
      data: {
        uploadUrl: "https://bucket.s3.amazonaws.com/key?presigned",
        publicUrl: "https://bucket.s3.amazonaws.com/uploads/user/123.png",
        key: "uploads/user/123.png",
      },
    });

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
    vi.spyOn(globalThis, "XMLHttpRequest").mockImplementation(() => xhrMock as unknown as XMLHttpRequest);

    render(<ImageUpload />);

    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files: [makeFile()] } });

    await waitFor(() => screen.getByText("Replace"));

    await userEvent.click(screen.getByText("Replace"));
    expect(screen.getByText("Click to upload")).toBeInTheDocument();
  });
});
