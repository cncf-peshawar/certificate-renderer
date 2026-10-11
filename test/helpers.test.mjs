import test from "node:test";
import assert from "node:assert/strict";
import {
  applyCasing,
  csvCell,
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

test("normalizes safe filenames and casing", () => {
  assert.equal(safeFilename("CNCF 001 / Rayyan"), "CNCF-001-Rayyan");
  assert.equal(applyCasing("aMina kHAN", "title"), "Amina Khan");
});
