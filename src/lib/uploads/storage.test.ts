import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  copyObject,
  deleteObject,
  parseContentRangeTotal,
  readObjectHead,
  StorageError,
} from "@/lib/uploads/storage";
import { SNIFF_BYTE_COUNT } from "@/lib/uploads/sniff";
import { PNG_HEADER } from "@/test/image-bytes";

const TARGET = {
  bucket: "my-bucket",
  key: "quarantine/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png",
  region: "us-east-1",
  accessKeyId: "mock-access-key-id",
  secretAccessKey: "mock-secret-access-key",
};

/** A 206 shaped the way S3 answers a range request. */
function partial(
  bytes: Uint8Array,
  total: number,
  contentType = "image/png",
): Response {
  return new Response(bytes as unknown as BodyInit, {
    status: 206,
    headers: {
      "content-type": contentType,
      "content-length": String(bytes.length),
      "content-range": `bytes 0-${Math.max(bytes.length - 1, 0)}/${total}`,
    },
  });
}

beforeEach(() => {
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("parseContentRangeTotal", () => {
  it("reads the object's full length from after the slash", () => {
    // A range request is the cheapest way to learn the whole object's size: a
    // separate HEAD would be a second round trip for a number already here.
    expect(parseContentRangeTotal("bytes 0-511/12345")).toBe(12345);
    expect(parseContentRangeTotal("  bytes 0-0/1  ")).toBe(1);
  });

  it("returns null for anything it cannot parse", () => {
    for (const value of [
      null,
      "",
      "bytes 0-511/*",
      "items 0-511/12345",
      "bytes */12345",
      "12345",
    ]) {
      expect(parseContentRangeTotal(value), JSON.stringify(value)).toBeNull();
    }
  });
});

describe("readObjectHead", () => {
  it("requests only the header bytes", async () => {
    const fetchImpl = vi.fn(async () => partial(PNG_HEADER, 4096));

    await readObjectHead(TARGET, fetchImpl as unknown as typeof fetch);

    const [, init] = fetchImpl.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect((init.headers as Record<string, string>)["range"]).toBe(
      `bytes=0-${SNIFF_BYTE_COUNT - 1}`,
    );
  });

  it("aims the request at the bucket's host, with no caller input in it", async () => {
    const fetchImpl = vi.fn(async () => partial(PNG_HEADER, 4096));

    await readObjectHead(TARGET, fetchImpl as unknown as typeof fetch);

    const url = new URL((fetchImpl.mock.calls[0]! as unknown as [string])[0]);
    expect(url.host).toBe("my-bucket.s3.us-east-1.amazonaws.com");
    expect(url.searchParams.get("X-Amz-Signature")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns the bytes, the object's real length and the stored type", async () => {
    const fetchImpl = async () => partial(PNG_HEADER, 4096, "image/png");

    const head = await readObjectHead(
      TARGET,
      fetchImpl as unknown as typeof fetch,
    );

    expect(Array.from(head.bytes)).toEqual(Array.from(PNG_HEADER));
    expect(head.totalBytes).toBe(4096);
    expect(head.storedContentType).toBe("image/png");
  });

  it("takes the length from Content-Range, not from the slice's Content-Length", async () => {
    // A 206's `Content-Length` is the length of the *slice*. Reading the cap
    // against it would let any object through, since the slice is always 512
    // bytes or fewer.
    const head = await readObjectHead(TARGET, (async () =>
      partial(PNG_HEADER, 9_000_000)) as unknown as typeof fetch);

    expect(head.totalBytes).toBe(9_000_000);
  });

  it("falls back to Content-Length when the range was ignored", async () => {
    // A bucket, proxy or S3-compatible implementation may answer 200 with the
    // whole object. The response is bounded on this side instead.
    const whole = new Uint8Array(1024);
    whole.set(PNG_HEADER, 0);

    const head = await readObjectHead(
      TARGET,
      (async () =>
        new Response(whole as unknown as BodyInit, {
          status: 200,
          headers: { "content-type": "image/png", "content-length": "1024" },
        })) as unknown as typeof fetch,
    );

    expect(head.totalBytes).toBe(1024);
    expect(head.bytes.length).toBe(SNIFF_BYTE_COUNT);
  });

  it("truncates a whole-object response to the header window", async () => {
    const whole = new Uint8Array(SNIFF_BYTE_COUNT * 4);
    whole.set(PNG_HEADER, 0);

    const head = await readObjectHead(
      TARGET,
      (async () =>
        new Response(whole as unknown as BodyInit, {
          status: 200,
          headers: {
            "content-type": "image/png",
            "content-length": String(whole.length),
          },
        })) as unknown as typeof fetch,
    );

    expect(head.bytes.length).toBe(SNIFF_BYTE_COUNT);
  });

  it("throws when the length cannot be established at all", async () => {
    // Accepting it would mean enforcing the size cap against a number nobody
    // measured, which is the defect this whole item is about.
    await expect(
      readObjectHead(
        TARGET,
        (async () =>
          new Response(PNG_HEADER as unknown as BodyInit, {
            status: 206,
            headers: { "content-type": "image/png" },
          })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(StorageError);
  });

  it("throws on a non-2xx rather than treating it as an empty object", async () => {
    // Zero bytes sniff as nothing, so a swallowed 404 would have shown up as a
    // type mismatch — a misleading answer to a question that was never asked.
    await expect(
      readObjectHead(
        TARGET,
        (async () =>
          new Response("", { status: 404 })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/HTTP 404/);
  });

  it("defaults a missing Content-Type to the empty string, not to a guess", async () => {
    const head = await readObjectHead(
      TARGET,
      (async () =>
        new Response(PNG_HEADER as unknown as BodyInit, {
          status: 206,
          headers: { "content-range": "bytes 0-11/4096" },
        })) as unknown as typeof fetch,
    );

    // `checkDeclaredType` refuses the empty string, so an object with no stored
    // type is refused rather than sniffed and accepted.
    expect(head.storedContentType).toBe("");
  });
});

describe("copyObject", () => {
  it("signs and sends the copy source and the replacement type", async () => {
    const fetchImpl = vi.fn(async () => new Response("<CopyObjectResult/>"));

    await copyObject(
      {
        ...TARGET,
        key: "uploads/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png",
        sourceKey: TARGET.key,
        contentType: "image/png",
      },
      fetchImpl as unknown as typeof fetch,
    );

    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    const headers = init.headers as Record<string, string>;

    expect(init.method).toBe("PUT");
    expect(new URL(url).pathname).toBe(
      "/uploads/user_1/1767225600000-1b4e28ba-2fa1-11d2-883f-0016d3cca427.png",
    );
    expect(headers["x-amz-copy-source"]).toBe(`/my-bucket/${TARGET.key}`);
    expect(headers["x-amz-metadata-directive"]).toBe("REPLACE");
    expect(headers["content-type"]).toBe("image/png");
  });

  it("throws on a non-2xx", async () => {
    await expect(
      copyObject(
        {
          ...TARGET,
          key: "uploads/user_1/x.png",
          sourceKey: TARGET.key,
          contentType: "image/png",
        },
        (async () =>
          new Response("", { status: 403 })) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/HTTP 403/);
  });

  it("throws on a 200 that carries an error document", async () => {
    // S3's CopyObject reports a failure that happens after the response headers
    // have gone out by putting an <Error> in the body of a 200. A copy checked
    // only by status would report success for an object that was never written.
    await expect(
      copyObject(
        {
          ...TARGET,
          key: "uploads/user_1/x.png",
          sourceKey: TARGET.key,
          contentType: "image/png",
        },
        (async () =>
          new Response(
            '<?xml version="1.0"?><Error><Code>InternalError</Code></Error>',
            { status: 200 },
          )) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/error document/);
  });
});

describe("deleteObject", () => {
  it("presigns and sends a DELETE", async () => {
    const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));

    await expect(
      deleteObject(TARGET, fetchImpl as unknown as typeof fetch),
    ).resolves.toBe(true);

    const [url, init] = fetchImpl.mock.calls[0]! as unknown as [
      string,
      RequestInit,
    ];
    expect(init.method).toBe("DELETE");
    expect(new URL(url).pathname).toBe(`/${TARGET.key}`);
  });

  it("reports a failure without throwing", async () => {
    // Cleanup on a path that has already decided to refuse an upload. Throwing
    // here would turn a clean rejection into a server fault, and "your file was
    // rejected, and also we could not delete it" helps nobody.
    await expect(
      deleteObject(
        TARGET,
        (async () =>
          new Response("", { status: 403 })) as unknown as typeof fetch,
      ),
    ).resolves.toBe(false);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("upload.quarantine_delete_failed"),
    );
  });

  it("swallows a thrown network error too", async () => {
    await expect(
      deleteObject(TARGET, (async () => {
        throw new Error("ECONNRESET");
      }) as unknown as typeof fetch),
    ).resolves.toBe(false);

    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining("ECONNRESET"),
    );
  });

  it("logs one parseable JSON line naming the key", async () => {
    await deleteObject(
      TARGET,
      (async () =>
        new Response("", { status: 500 })) as unknown as typeof fetch,
    );

    const line = vi.mocked(console.warn).mock.calls[0]![0] as string;
    expect(JSON.parse(line)).toMatchObject({
      event: "upload.quarantine_delete_failed",
      key: TARGET.key,
      status: 500,
    });
  });
});
