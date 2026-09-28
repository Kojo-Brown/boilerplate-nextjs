import { describe, it, expect, vi, beforeEach } from "vitest";
import { REJECTION_MESSAGES, verifyUploadedObject } from "@/lib/uploads/verify";
import type { RejectionReason } from "@/lib/uploads/verify";
import { MAX_FILE_SIZE_BYTES } from "@/lib/uploads/policy";
import { unconfiguredScanner } from "@/lib/uploads/scan";
import type { ScanVerdict, UploadScanner } from "@/lib/uploads/scan";
import { SNIFF_BYTE_COUNT } from "@/lib/uploads/sniff";
import { GIF89_HEADER, HTML_DOCUMENT, PNG_HEADER } from "@/test/image-bytes";

const BUCKET = {
  bucket: "my-bucket",
  region: "us-east-1",
  accessKeyId: "mock-access-key-id",
  secretAccessKey: "mock-secret-access-key",
};

const QUARANTINE_KEY =
  "quarantine/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png";
const PUBLIC_KEY =
  "uploads/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png";

/**
 * A `fetch` that answers each of the three operations verification performs,
 * dispatched on method and on whether the URL names the quarantine key.
 *
 * One stub rather than three so that a test can assert what did *not* happen —
 * "the object was deleted" and "the object was promoted" are both claims about
 * calls that this records in order.
 */
function stubFetch(options: {
  bytes?: Uint8Array;
  totalBytes?: number;
  storedContentType?: string;
  readStatus?: number;
  copyStatus?: number;
  copyBody?: string;
}) {
  const bytes = options.bytes ?? PNG_HEADER;
  const totalBytes = options.totalBytes ?? 4096;
  const calls: { method: string; key: string }[] = [];

  const impl = vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const key = decodeURIComponent(new URL(url).pathname.slice(1));
    calls.push({ method, key });

    if (method === "GET") {
      if (options.readStatus && options.readStatus !== 206) {
        return new Response("", { status: options.readStatus });
      }
      return new Response(bytes as unknown as BodyInit, {
        status: 206,
        headers: {
          "content-type": options.storedContentType ?? "image/png",
          "content-length": String(bytes.length),
          "content-range": `bytes 0-${Math.max(bytes.length - 1, 0)}/${totalBytes}`,
        },
      });
    }

    if (method === "PUT") {
      return new Response(options.copyBody ?? "<CopyObjectResult/>", {
        status: options.copyStatus ?? 200,
      });
    }

    return new Response(null, { status: 204 });
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function scannerReturning(
  verdict: ScanVerdict,
  requirement: UploadScanner["requirement"] = "required",
): UploadScanner {
  return {
    name: "stub",
    requirement,
    scan: vi.fn(async () => verdict),
  };
}

const cleanScanner = scannerReturning({ status: "clean" });

let report: ReturnType<typeof vi.fn>;

beforeEach(() => {
  report = vi.fn();
});

function run(
  overrides: Parameters<typeof stubFetch>[0] = {},
  scanner: UploadScanner = cleanScanner,
  declaredSizeBytes = 4096,
) {
  const { impl, calls } = stubFetch(overrides);
  return {
    calls,
    impl,
    outcome: verifyUploadedObject(
      {
        target: BUCKET,
        quarantineKey: QUARANTINE_KEY,
        declaredSizeBytes,
      },
      { scanner, fetchImpl: impl, report },
    ),
  };
}

describe("verifyUploadedObject — the accepting path", () => {
  it("promotes a verified object and returns its public URL", async () => {
    const { outcome, calls } = run();

    await expect(outcome).resolves.toEqual({
      accepted: true,
      key: PUBLIC_KEY,
      publicUrl: `https://my-bucket.s3.us-east-1.amazonaws.com/${PUBLIC_KEY}`,
      type: "image/png",
      sizeBytes: 4096,
      scanned: true,
    });

    expect(calls).toEqual([
      { method: "GET", key: QUARANTINE_KEY },
      { method: "PUT", key: PUBLIC_KEY },
      { method: "DELETE", key: QUARANTINE_KEY },
    ]);
  });

  it("copies before deleting, so a failed copy never loses the only copy", async () => {
    const { outcome, calls } = run({ copyStatus: 403 });

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "not-promotable",
    });

    expect(calls.map((call) => call.method)).toEqual(["GET", "PUT"]);
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);
  });

  it("logs one accepted line naming the public key and the scanner", async () => {
    await run().outcome;

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "upload.accepted",
        level: "info",
        key: PUBLIC_KEY,
        type: "image/png",
        sizeBytes: 4096,
        scanner: "stub",
        scanned: true,
      }),
    );
  });

  it("accepts an object of exactly the cap", async () => {
    // A boundary worth pinning: `>` versus `>=` here is the difference between a
    // 5 MB limit and a 5 MB minus one limit.
    const { outcome } = run(
      { totalBytes: MAX_FILE_SIZE_BYTES },
      cleanScanner,
      MAX_FILE_SIZE_BYTES,
    );

    await expect(outcome).resolves.toMatchObject({ accepted: true });
  });
});

describe("verifyUploadedObject — no scanner configured", () => {
  it("accepts the upload and records that nothing scanned it", async () => {
    // The supported state. The only thing separating "supported" from
    // "forgotten" is that every single upload says so in the log.
    const { outcome } = run({}, unconfiguredScanner);

    await expect(outcome).resolves.toMatchObject({
      accepted: true,
      scanned: false,
    });

    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "upload.accepted",
        level: "warn",
        scanner: "none",
        scanned: false,
      }),
    );
  });

  it("still refuses a file whose bytes disagree with its stored type", async () => {
    // The sniff is not conditional on a scanner existing.
    const { outcome } = run({ bytes: HTML_DOCUMENT }, unconfiguredScanner);

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "type-mismatch",
    });
  });
});

describe("verifyUploadedObject — the size cap", () => {
  it("refuses an object over the cap and deletes it", async () => {
    const { outcome, calls } = run(
      { totalBytes: MAX_FILE_SIZE_BYTES + 1 },
      cleanScanner,
      MAX_FILE_SIZE_BYTES + 1,
    );

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "too-large",
    });

    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
  });

  it("measures the stored object rather than believing the declared size", async () => {
    // The whole point. Before this item the cap was checked against a number the
    // caller supplied and then dropped: a declared `sizeBytes: 1` minted a URL
    // good for five gigabytes.
    const { outcome } = run({ totalBytes: 40 * 1024 * 1024 }, cleanScanner, 1);

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "too-large",
    });
  });

  it("refuses a length that disagrees with the signed one, even under the cap", async () => {
    // `content-length` is signed into the upload URL, so S3 should have refused
    // a PUT of any other length. A mismatch means that binding is not doing what
    // this code believes, or the object was written by another route — either one
    // invalidates the cap.
    const { outcome, calls } = run({ totalBytes: 2048 }, cleanScanner, 4096);

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "size-mismatch",
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
  });

  it("checks the size before it pays for a scan", async () => {
    const scanner = scannerReturning({ status: "clean" });
    const { outcome } = run(
      { totalBytes: MAX_FILE_SIZE_BYTES + 1 },
      scanner,
      MAX_FILE_SIZE_BYTES + 1,
    );

    await outcome;
    expect(scanner.scan).not.toHaveBeenCalled();
  });
});

describe("verifyUploadedObject — the content sniff", () => {
  it("refuses an HTML document stored as image/png and deletes it", async () => {
    // The original bypass, end to end: rename `payload.html` to `payload.png`,
    // and every check in the old path passed because all three read the name.
    const { outcome, calls } = run({ bytes: HTML_DOCUMENT });

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "type-mismatch",
    });
    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
  });

  it("refuses bytes that are a different accepted format", async () => {
    const { outcome } = run({ bytes: GIF89_HEADER });

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "type-mismatch",
    });
  });

  it("compares against the type S3 stored, not one the caller re-declares", async () => {
    // `finalizeUploadAction` takes no content type: the comparison is between the
    // bytes and the header S3 will serve them with, which is the question a
    // browser eventually asks. A caller-supplied type would let the caller pick
    // both sides of the comparison.
    const { outcome } = run({
      bytes: GIF89_HEADER,
      storedContentType: "image/gif",
    });

    await expect(outcome).resolves.toMatchObject({
      accepted: true,
      type: "image/gif",
    });
  });

  it("refuses an object S3 stored with no type at all", async () => {
    const { outcome } = run({ storedContentType: "" });

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "type-mismatch",
    });
  });

  it("promotes with the sniffed type, so the served header matches the bytes", async () => {
    const { impl, calls } = stubFetch({
      bytes: GIF89_HEADER,
      storedContentType: "image/gif",
    });

    await verifyUploadedObject(
      {
        target: BUCKET,
        quarantineKey: QUARANTINE_KEY,
        declaredSizeBytes: 4096,
      },
      { scanner: cleanScanner, fetchImpl: impl, report },
    );

    expect(calls.some((call) => call.method === "PUT")).toBe(true);
    const copyCall = vi
      .mocked(impl)
      .mock.calls.find(([, init]) => init?.method === "PUT")!;
    const headers = (copyCall[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["content-type"]).toBe("image/gif");
  });

  it("checks the type before it pays for a scan", async () => {
    const scanner = scannerReturning({ status: "clean" });
    const { outcome } = run({ bytes: HTML_DOCUMENT }, scanner);

    await outcome;
    expect(scanner.scan).not.toHaveBeenCalled();
  });
});

describe("verifyUploadedObject — the scan", () => {
  it("refuses an infected object, deletes it, and logs at error", async () => {
    const { outcome, calls } = run(
      {},
      scannerReturning({ status: "infected", signature: "Eicar-Test-File" }),
    );

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "infected",
    });

    expect(calls.map((call) => call.method)).toEqual(["GET", "DELETE"]);
    expect(report).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "upload.rejected",
        level: "error",
        reason: "infected",
      }),
    );
  });

  it("keeps no copy of an infected object for analysis", async () => {
    // A retention decision about someone else's malware, and the wrong default
    // for a boilerplate is the one that hoards it.
    const { outcome, calls } = run(
      {},
      scannerReturning({ status: "infected", signature: "X" }),
    );

    await outcome;
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });

  it("refuses when a configured scanner does not answer", async () => {
    const { outcome } = run(
      {},
      scannerReturning(
        { status: "unavailable", reason: "timeout" },
        "required",
      ),
    );

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "unscannable",
    });
  });

  it("hands the scanner the object's real length, not the declared one", async () => {
    const scanner = scannerReturning({ status: "clean" });
    await run({ totalBytes: 4096 }, scanner, 4096).outcome;

    expect(scanner.scan).toHaveBeenCalledWith({
      bucket: "my-bucket",
      key: QUARANTINE_KEY,
      declaredType: "image/png",
      sizeBytes: 4096,
    });
  });

  it("scans the quarantine key, before anything is public", async () => {
    const scanner = scannerReturning({ status: "clean" });
    await run({}, scanner).outcome;

    expect(vi.mocked(scanner.scan).mock.calls[0]![0].key).toBe(QUARANTINE_KEY);
  });
});

describe("verifyUploadedObject — failures of its own", () => {
  it("refuses a key it did not mint, without touching the network", async () => {
    const { impl } = stubFetch({});

    await expect(
      verifyUploadedObject(
        {
          target: BUCKET,
          quarantineKey: "quarantine/user_1/../evil.png",
          declaredSizeBytes: 4096,
        },
        { scanner: cleanScanner, fetchImpl: impl, report },
      ),
    ).resolves.toMatchObject({ accepted: false, reason: "not-promotable" });

    expect(impl).not.toHaveBeenCalled();
  });

  it("refuses a key that is already public", async () => {
    // Otherwise finalize would re-copy an object over itself, a write it has no
    // business making.
    const { impl } = stubFetch({});

    await expect(
      verifyUploadedObject(
        {
          target: BUCKET,
          quarantineKey: PUBLIC_KEY,
          declaredSizeBytes: 4096,
        },
        { scanner: cleanScanner, fetchImpl: impl, report },
      ),
    ).resolves.toMatchObject({ accepted: false, reason: "not-promotable" });

    expect(impl).not.toHaveBeenCalled();
  });

  it("reports an unreadable object and deletes nothing", async () => {
    // An object that could not be read is an object whose state is unknown, and
    // issuing a delete for a key whose read just failed is as likely to be a
    // no-op as a cleanup.
    const { outcome, calls } = run({ readStatus: 404 });

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "unreadable",
    });
    expect(calls.map((call) => call.method)).toEqual(["GET"]);
  });

  it("reports a copy that answered 200 with an error document", async () => {
    const { outcome } = run({
      copyBody:
        '<?xml version="1.0"?><Error><Code>InternalError</Code></Error>',
    });

    await expect(outcome).resolves.toMatchObject({
      accepted: false,
      reason: "not-promotable",
    });
  });

  it("logs exactly one line for every rejection reason", async () => {
    // So that a log search for refused uploads cannot miss a branch.
    const cases: [RejectionReason, () => Promise<unknown>][] = [
      [
        "too-large",
        () =>
          run(
            { totalBytes: MAX_FILE_SIZE_BYTES + 1 },
            cleanScanner,
            MAX_FILE_SIZE_BYTES + 1,
          ).outcome,
      ],
      [
        "size-mismatch",
        () => run({ totalBytes: 99 }, cleanScanner, 4096).outcome,
      ],
      ["type-mismatch", () => run({ bytes: HTML_DOCUMENT }).outcome],
      ["unreadable", () => run({ readStatus: 500 }).outcome],
      ["not-promotable", () => run({ copyStatus: 500 }).outcome],
      [
        "infected",
        () =>
          run({}, scannerReturning({ status: "infected", signature: "X" }))
            .outcome,
      ],
      [
        "unscannable",
        () =>
          run({}, scannerReturning({ status: "unavailable", reason: "down" }))
            .outcome,
      ],
    ];

    for (const [reason, execute] of cases) {
      report.mockClear();
      await execute();

      expect(report, reason).toHaveBeenCalledTimes(1);
      expect(report.mock.calls[0]![0], reason).toMatchObject({
        event: "upload.rejected",
        reason,
        key: QUARANTINE_KEY,
      });
    }
  });
});

describe("REJECTION_MESSAGES", () => {
  it("covers every rejection reason", async () => {
    // A missing entry is `undefined` handed to `ActionError`, which reaches the
    // browser as an empty error toast.
    const reasons: RejectionReason[] = [
      "too-large",
      "size-mismatch",
      "type-mismatch",
      "infected",
      "unscannable",
      "unreadable",
      "not-promotable",
    ];

    for (const reason of reasons) {
      expect(REJECTION_MESSAGES[reason], reason).toMatch(/\S/);
    }
  });

  it("tells the caller less than the audit line does", async () => {
    // The log gets "the stored object is 7340032 bytes" and "its leading bytes
    // are a GIF"; those are useful to whoever reads it and a free oracle for
    // whoever is probing the check.
    const { outcome } = run({ bytes: GIF89_HEADER });
    await outcome;

    const logged = String(report.mock.calls[0]![0]["detail"]);
    expect(logged).toContain("image/gif");
    expect(REJECTION_MESSAGES["type-mismatch"]).not.toContain("image/gif");
  });
});

describe("verifyUploadedObject — the readback is bounded", () => {
  it("never asks for more than the sniff window", async () => {
    const { impl } = stubFetch({});

    await verifyUploadedObject(
      {
        target: BUCKET,
        quarantineKey: QUARANTINE_KEY,
        declaredSizeBytes: 4096,
      },
      { scanner: cleanScanner, fetchImpl: impl, report },
    );

    const readCall = vi
      .mocked(impl)
      .mock.calls.find(([, init]) => (init?.method ?? "GET") === "GET")!;
    const headers = (readCall[1] as RequestInit).headers as Record<
      string,
      string
    >;
    expect(headers["range"]).toBe(`bytes=0-${SNIFF_BYTE_COUNT - 1}`);
  });
});
