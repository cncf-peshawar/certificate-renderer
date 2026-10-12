# CNCF Peshawar certificate renderer

This public repository supplies auditable, disk-backed batch rendering for the private CNCF Peshawar Certificate Platform. Public source does not make certificate data public. Every roster, normalized template, generated PDF, manifest, and ZIP remains in a private Backblaze B2 bucket or temporary GitHub-hosted runner storage.

The private application is maintained in `cncf-peshawar/cncf-certificate-platform`. It owns users, authorization, D1, templates, job creation, verification records, downloads, and production deployment. This repository owns deterministic rendering only.

## Trust boundary

| Private application repository | Public renderer repository |
| --- | --- |
| Authenticates organizers | Has no organizer login |
| Validates rosters and template selection | Validates the private render payload and image |
| Stores metadata in D1 | Has no D1 credential or direct D1 access |
| Stores private inputs and template mirrors in B2 | Reads only the B2 data required for one job |
| Dispatches an opaque job ID | Accepts only `job_id` |
| Verifies signed callbacks | Signs status callbacks |
| Registers certificates after output upload | Cannot publish verification records itself |
| Authorizes and streams downloads | Cannot authorize or serve organizer downloads |

This repository must never contain:

- real or copied attendee names, emails, CSV rows, or manifests;
- production templates or generated certificates;
- B2 credentials, callback secrets, private object contents, or private URLs;
- workflow inputs other than the opaque job ID;
- GitHub artifacts or cache keys derived from attendee data.

Use invented non-identifying values in tests and documentation.

## Workflow contract

`.github/workflows/render.yml` uses only `workflow_dispatch` and declares one required string input:

```text
job_id=batch-<uuid>
```

The private Worker dispatches the workflow on protected `main`. The workflow:

1. checks out reviewed renderer source;
2. installs Node.js 22 and locked npm dependencies;
3. exposes the opaque ID and repository secrets only to the render step;
4. runs `npm run render`;
5. permits repository contents read access only;
6. serializes runs through the `certificate-renderer` concurrency group;
7. keeps `cancel-in-progress: false`, so a new job waits instead of cancelling an active render;
8. stops after 30 minutes if a render cannot finish.

Do not add `pull_request`, `pull_request_target`, fork, issue, or comment triggers to a secret-bearing render job. Pull requests may run secret-free tests, but they must never receive B2 or callback credentials.

## Private job flow

1. The private Worker writes `batch-inputs/<job-id>.json`.
2. This workflow receives only the job ID.
3. The renderer authorizes to B2 with its repository-specific key.
4. It downloads the expected input object and validates that the payload job ID matches the workflow job ID.
5. It downloads `templates/<template-id>.png` for custom templates, or fetches the protected default template only from the configured platform origin.
6. It sends a signed `running` callback.
7. It renders each certificate sequentially to an isolated temporary directory.
8. It sends a signed progress callback after every PDF.
9. It writes the private manifests and ZIP to runner disk.
10. It uploads `batch-exports/<job-id>.zip`.
11. It sends a signed `completed` callback containing the expected output key and public verification metadata.
12. It removes the temporary directory in a `finally` block.

If any step fails after the private payload is available, the renderer attempts a generic signed `failed` callback. It logs the job ID and a sanitized technical error, not attendee values.

The private Worker creates verification records only after the ZIP upload and valid completion callback. A renderer failure therefore does not publish partially generated certificates.

## Payload compatibility

The renderer accepts payload versions 1 and 2. The payload is private and is never a workflow input or artifact.

A valid payload contains:

- the same opaque job ID used for dispatch;
- 1-400 attendees;
- a template descriptor with normalized dimensions and field-layout snapshot;
- the trusted callback URL;
- event and issuer metadata needed for the output.

The renderer does not accept arbitrary callback origins, template origins, or B2 object paths. Custom template keys must match `templates/tpl-<uuid>.png`; input and output locations are derived from the validated job ID.

Version 2 is current. Newer payload versions must not be emitted by the private platform until this repository supports and deploys them. When both repositories change, deploy backward-compatible renderer support first.

## Template validation and drawing

The renderer accepts a normalized PNG only when all of these are true:

- the decoded format is PNG;
- width and height exist;
- neither edge exceeds 3,508 pixels;
- the image does not exceed 8.7 megapixels;
- decoded dimensions exactly match the private payload metadata.

The PNG is flattened against white and converted to a high-quality JPEG buffer before PDF placement. Text coordinates, font sizes, and maximum widths are scaled from template pixels to the PDF page. Rendering uses one certificate at a time, so a large batch does not hold every PDF in memory.

The supported text fields are recipient name, role, certificate date, and certificate ID. Field configuration controls visibility, alignment, casing, color, maximum width, position, and font sizing.

## Date behavior

For current version 2 jobs, the private Worker has already resolved blank dates to the current calendar date in `Asia/Karachi`. The renderer preserves the supplied resolved value across the PDF and manifests.

Legacy version 1 jobs need compatibility handling. If every attendee date is blank or equals the payload's old event-date default, the renderer treats those dates as legacy defaults and replaces them with the current Pakistan generation date.

A non-default explicit date is preserved. The completion callback returns the same resolved date used in the PDF and manifests, allowing D1 verification records to stay consistent.

## QR behavior

QR rendering is optional and deterministic:

- the template-layout snapshot must contain a `qr` field;
- the field must be explicitly enabled;
- the attendee must have a verification URL;
- the field's saved center coordinates and size control placement;
- the encoded value is the public verification URL;
- the code uses high error correction and a white backing area.

There is no automatic or random QR placement. A job submitted before a QR field was saved retains its earlier layout snapshot and will not gain a QR when re-rendered. Submit a new job after saving the layer.

## ZIP contract

A completed archive contains only:

```text
individual/pdf/<safe-certificate-id>_<safe-recipient-name>.pdf
manifest.csv
manifest.json
```

It contains no PNG copies and no merged PDF. File names are normalized and length-limited, but the private manifests retain the certificate metadata needed by organizers.

The renderer checks that the manifest row count equals the attendee count before upload.

## Signed callbacks

Every callback serializes its JSON body once and computes HMAC-SHA256 over those exact bytes using `BATCH_CALLBACK_SECRET`. The hexadecimal digest is sent in `X-Renderer-Signature`.

The callback URL comes from the private payload, but its origin must match `PLATFORM_URL`. The private Worker independently verifies the signature, job identifier, allowed state transition, progress, and exact output key.

The callback secret must be identical in the public renderer repository and private application environment. Rotate both sides together. During rotation, pause new submissions or use a coordinated deployment so callbacks are not signed and verified with different values.

## Repository secrets

Configure these encrypted Actions secrets:

| Secret | Purpose |
| --- | --- |
| `PLATFORM_URL` | Trusted private platform origin |
| `B2_KEY_ID` | Renderer-specific B2 application key ID |
| `B2_APPLICATION_KEY` | Renderer-specific B2 secret |
| `B2_BUCKET_ID` | Exact private bucket ID used for upload targets |
| `B2_BUCKET_NAME` | Exact private bucket name used for downloads |
| `BATCH_CALLBACK_SECRET` | HMAC secret shared only with the private Worker |

Use a separate key from the private Worker's B2 key. The renderer needs to read `batch-inputs/` and `templates/` and write `batch-exports/`. Backblaze standard keys may require the narrowest practical bucket-scoped read/write key because one key cannot express those three mixed prefixes. The code still constrains every path it constructs or accepts.

Never use a B2 account master key or a personal all-bucket key.

## Storage retention

The bucket is private. B2 lifecycle rules apply to `batch-inputs/` and `batch-exports/`: hide current files after one day, then delete hidden versions after one day. No 24-hour rule applies to `templates/`.

The private application's D1 expiry is the access boundary and disables download exactly 24 hours after job creation. B2 lifecycle cleanup is asynchronous physical deletion and can occur later.

## Local development

Requirements: Node.js 22 and npm.

```bash
npm ci
npm run check
```

`npm run check` syntax-checks the renderer and runs Node tests for:

- opaque job-ID validation;
- safe CSV escaping and filenames;
- Pakistan-local current-date behavior;
- explicit-date preservation;
- legacy date correction;
- enabled versus disabled QR selection;
- text casing.

A full production render requires private infrastructure credentials and an existing queued job. Do not copy production secrets into a local `.env` file and do not use a real roster for local testing. Prefer unit tests with invented inputs. If an integration test is required, use time-limited credentials, an isolated test bucket, and rotate them afterward.

## Review and release

Rayyan Shaheer is the designated required reviewer for this repository. Hassan is not the required reviewer for renderer changes.

Protect `main` with:

- pull requests;
- at least one approval;
- passing checks;
- resolved conversations;
- no force pushes or deletion;
- secrets unavailable to forks and pull requests.

Rayyan's configured bypass access is for audited maintenance or emergency recovery. Normal changes should still use a reviewed pull request.

Before merge:

1. run `npm ci && npm run check`;
2. inspect changes for new logging of payload or attendee values;
3. confirm the workflow still accepts only `job_id`;
4. confirm permissions remain `contents: read`;
5. review dependency-lock changes and rendering-library updates;
6. confirm B2 keys and callback/origin checks remain restricted.

After merge, submit a fresh small batch through the private Studio. Confirm automatic dispatch, accurate progress, date behavior, QR behavior, signed completion, authenticated download, and public verification. A manually triggered old job is useful for diagnosis but does not prove the private dispatch path works.

## Incident response

If a repository secret is exposed:

1. disable or revoke it immediately;
2. stop new batch submissions if callback or storage integrity is uncertain;
3. rotate the renderer B2 key without changing the Worker's separate key unless it was also exposed;
4. rotate `BATCH_CALLBACK_SECRET` on both sides in a coordinated change;
5. inspect Actions logs and B2 access for unexpected activity;
6. remove exposed logs or artifacts through GitHub support procedures where necessary;
7. record the incident privately without attendee data.

If roster data appears in a log, treat it as a privacy incident. Do not quote the affected log in a public issue.

## Related documentation

The private repository contains the authoritative cross-system documents:

- `docs/ARCHITECTURE_AND_OPERATIONS.md`
- `docs/BATCH_EXPORTS.md`
- `docs/B2_AND_PRODUCTION_SETUP.md`
- `docs/REMAINING_BATCH_EXPORT_TASKS.md`
- `HANDOVER.md`

This repository remains intentionally small: renderer source, tests, lockfile, workflow, and public operational explanation only.
