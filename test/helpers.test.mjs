import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCasing,
  csvCell,
  findEnabledQrField,
  formatCertificateDate,
  resolveCertificateDate,
  safeFilename,
  validateJobId,
} from "../src/render.mjs";

test("accepts only opaque batch identifiers", () => {
  assert.equal(
    validateJobId("batch-12345678-1234-1234-1234-123456789abc"),
    "batch-12345678-1234-1234-1234-123456789abc",
  );
  assert.throws(() => validateJobId("../../roster.csv"));
});

test("escapes manifest cells without losing unicode", () => {
  assert.equal(csvCell('A, "B"'), '"A, ""B"""');
  assert.equal(csvCell("Peshawar"), "Peshawar");
});

test("uses the Pakistan-local generation date for blank and legacy-defaulted dates", () => {
  const generatedAt = new Date("2026-10-11T23:30:00.000Z");
  const generationDate = formatCertificateDate(generatedAt);

  assert.equal(generationDate, "October 12, 2026");
  assert.equal(
    resolveCertificateDate("", generationDate, false),
    generationDate,
  );
  assert.equal(
    resolveCertificateDate("October 9, 2026", generationDate, true),
    generationDate,
  );
  assert.equal(
    resolveCertificateDate("October 9, 2026", generationDate, false),
    "October 9, 2026",
  );
});

test("renders QR only for an explicitly enabled template layer", () => {
  assert.equal(findEnabledQrField([]), undefined);
  assert.equal(
    findEnabledQrField([{ field: "qr", enabled: false }]),
    undefined,
  );
  assert.deepEqual(
    findEnabledQrField([{ field: "qr", enabled: true, x: 100, y: 200 }]),
    { field: "qr", enabled: true, x: 100, y: 200 },
  );
});

test("normalizes safe filenames and casing", () => {
  assert.equal(safeFilename("CNCF 001 / Rayyan"), "CNCF-001-Rayyan");
  assert.equal(applyCasing("aMina kHAN", "title"), "Amina Khan");
});
