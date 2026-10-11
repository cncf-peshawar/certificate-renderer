# CNCF Peshawar certificate renderer

Public, auditable GitHub Actions renderer for the private CNCF Peshawar Certificate Platform.

The workflow accepts one value: an opaque batch job ID. It does not accept CSV data, names, email addresses, template URLs, or object paths. Inputs and exports use a private Backblaze B2 bucket; GitHub artifacts are never used.

## Rendering contract

The Action:

1. validates the opaque job ID;
2. downloads batch-inputs/<job-id>.json from private B2;
3. validates the normalized PNG template;
4. renders one PDF at a time to runner disk with PDFKit, QRCode, and Sharp;
5. creates individual/pdf/, manifest.csv, and manifest.json;
6. streams the ZIP to batch-exports/<job-id>.zip;
7. signs progress and completion callbacks with HMAC-SHA256;
8. deletes its temporary runner directory.

No roster value is intentionally written to logs. A failed run sends only a generic failed callback. Verification records are registered by the private Worker only after output upload succeeds.

## Repository secrets

Configure:

- PLATFORM_URL
- B2_KEY_ID
- B2_APPLICATION_KEY
- B2_BUCKET_ID
- B2_BUCKET_NAME
- BATCH_CALLBACK_SECRET

Use a B2 application key that can read batch-inputs/ and templates/ and write batch-exports/. The bucket must remain private. Temporary objects are deleted by 24-hour B2 lifecycle rules configured on batch-inputs/ and batch-exports/.

## Security

- Keep this repository public so the renderer source is reviewable.
- Protect main with pull requests, at least one approval, resolved conversations, and passing checks.
- Never expose secrets to pull_request or fork workflows.
- Keep workflow permissions at contents: read.
- Keep cancel-in-progress disabled so queued jobs are not discarded.
- Never add attendee values to logs, workflow inputs, job names, artifacts, or cache keys.
- Rotate the B2 and callback credentials if an Actions secret is exposed.

## Local checks

Requires Node.js 22.

    npm ci
    npm run check

A full render requires private infrastructure secrets and an existing queued job. Do not use production rosters for local tests.

## Deployment

Changes deploy when they reach the protected main branch. The private platform dispatches .github/workflows/render.yml through a repository-scoped fine-grained token with Actions read/write access.

This repository contains no attendee data, templates, outputs, or credentials.
