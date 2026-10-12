import { createHmac } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import archiver from "archiver";
import PDFDocument from "pdfkit";
import QRCode from "qrcode";
import sharp from "sharp";

const MAX_EDGE = 3508;
const MAX_PIXELS = 8_700_000;
const PAGE_WIDTH = 841.89;
const REQUIRED_ENV = [
  "JOB_ID",
  "PLATFORM_URL",
  "B2_KEY_ID",
  "B2_APPLICATION_KEY",
  "B2_BUCKET_ID",
  "B2_BUCKET_NAME",
  "BATCH_CALLBACK_SECRET",
];

export function validateJobId(value) {
  if (!/^batch-[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(value || "")) {
    throw new Error("Invalid opaque job identifier.");
  }
  return value;
}

export function applyCasing(value, casing = "preserve") {
  const text = String(value || "").trim();
  if (casing === "upper") return text.toUpperCase();
  if (casing === "lower") return text.toLowerCase();
  if (casing === "title") {
    return text
      .toLowerCase()
      .replace(/\b[\p{L}\p{N}]/gu, (character) => character.toUpperCase());
  }
  return text;
}

export function safeFilename(value) {
  return (
    String(value || "")
      .normalize("NFKD")
      .replace(/[^a-zA-Z0-9_-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "certificate"
  );
}

export function formatCertificateDate(date = new Date()) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Karachi",
    month: "long",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

export function resolveCertificateDate(value, generationDate, legacyDefaulted) {
  return legacyDefaulted
    ? generationDate
    : String(value || "").trim() || generationDate;
}

export function findEnabledQrField(fields) {
  return Array.isArray(fields)
    ? fields.find((field) => field.field === "qr" && field.enabled !== false)
    : undefined;
}

export function csvCell(value) {
  const text = String(value ?? "");
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function requireEnvironment() {
  for (const name of REQUIRED_ENV) {
    if (!process.env[name]) throw new Error(`Missing required secret: ${name}`);
  }
}

async function authorizeB2() {
  const basic = Buffer.from(
    `${process.env.B2_KEY_ID}:${process.env.B2_APPLICATION_KEY}`,
  ).toString("base64");
  const response = await fetch(
    "https://api.backblazeb2.com/b2api/v3/b2_authorize_account",
    {
      headers: { Authorization: `Basic ${basic}` },
    },
  );
  if (!response.ok) throw new Error("Private storage authorization failed.");
  const body = await response.json();
  const storage = body.apiInfo?.storageApi;
  const apiUrl = body.apiUrl || storage?.apiUrl;
  const downloadUrl = body.downloadUrl || storage?.downloadUrl;
  if (!body.authorizationToken || !apiUrl || !downloadUrl) {
    throw new Error(
      "Private storage returned an invalid authorization response.",
    );
  }
  return { token: body.authorizationToken, apiUrl, downloadUrl };
}

function objectUrl(downloadUrl, key) {
  const bucket = encodeURIComponent(process.env.B2_BUCKET_NAME);
  const object = key.split("/").map(encodeURIComponent).join("/");
  return `${downloadUrl}/file/${bucket}/${object}`;
}

async function downloadB2(auth, key) {
  const response = await fetch(objectUrl(auth.downloadUrl, key), {
    headers: { Authorization: auth.token },
  });
  if (!response.ok)
    throw new Error("A required private batch object is unavailable.");
  return Buffer.from(await response.arrayBuffer());
}

async function uploadB2(auth, key, filePath, contentType) {
  const targetResponse = await fetch(
    `${auth.apiUrl}/b2api/v3/b2_get_upload_url`,
    {
      method: "POST",
      headers: {
        Authorization: auth.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ bucketId: process.env.B2_BUCKET_ID }),
    },
  );
  if (!targetResponse.ok)
    throw new Error("Could not obtain a private storage upload target.");
  const target = await targetResponse.json();
  const file = await stat(filePath);
  const response = await fetch(target.uploadUrl, {
    method: "POST",
    duplex: "half",
    headers: {
      Authorization: target.authorizationToken,
      "X-Bz-File-Name": encodeURIComponent(key),
      "Content-Type": contentType,
      "Content-Length": String(file.size),
      "X-Bz-Content-Sha1": "do_not_verify",
    },
    body: createReadStream(filePath),
  });
  if (!response.ok)
    throw new Error("Could not upload the completed batch archive.");
}

async function callback(payload, callbackUrl) {
  const url = new URL(callbackUrl);
  if (url.origin !== new URL(process.env.PLATFORM_URL).origin) {
    throw new Error("The callback destination is not trusted.");
  }
  const body = JSON.stringify(payload);
  const signature = createHmac("sha256", process.env.BATCH_CALLBACK_SECRET)
    .update(body)
    .digest("hex");
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Renderer-Signature": signature,
    },
    body,
  });
  if (!response.ok)
    throw new Error("The private platform rejected a renderer update.");
}

async function readTemplate(auth, template) {
  let bytes;
  if (template.storage_key) {
    if (!/^templates\/tpl-[0-9a-f-]+\.png$/i.test(template.storage_key)) {
      throw new Error("Invalid template storage key.");
    }
    bytes = await downloadB2(auth, template.storage_key);
  } else {
    const url = new URL(template.source_url);
    if (url.origin !== new URL(process.env.PLATFORM_URL).origin) {
      throw new Error("The template source is not trusted.");
    }
    const response = await fetch(url);
    if (!response.ok) throw new Error("The default template is unavailable.");
    bytes = Buffer.from(await response.arrayBuffer());
  }

  const metadata = await sharp(bytes).metadata();
  if (
    metadata.format !== "png" ||
    !metadata.width ||
    !metadata.height ||
    metadata.width > MAX_EDGE ||
    metadata.height > MAX_EDGE ||
    metadata.width * metadata.height > MAX_PIXELS ||
    metadata.width !== template.width ||
    metadata.height !== template.height
  ) {
    throw new Error("The template failed normalized-image validation.");
  }
  return sharp(bytes)
    .flatten({ background: "#ffffff" })
    .jpeg({ quality: 92, mozjpeg: true, chromaSubsampling: "4:4:4" })
    .toBuffer();
}

function drawField(document, field, attendee, template, pageWidth, pageHeight) {
  if (field.enabled === false) return;
  const values = {
    name: attendee.name,
    role: attendee.role || "Attendee",
    date: attendee.date || "",
    cert_id: attendee.certId,
  };
  if (!(field.field in values)) return;
  const value = applyCasing(values[field.field], field.casing);
  if (!value) return;

  const x = (field.x / template.width) * pageWidth;
  const y = (field.y / template.height) * pageHeight;
  const fontSize = Math.max(5, (field.font_size / template.width) * pageWidth);
  const maxWidth = field.max_width
    ? (field.max_width / template.width) * pageWidth
    : pageWidth * 0.8;
  const align = ["left", "center", "right"].includes(field.align)
    ? field.align
    : "center";
  const left =
    align === "center"
      ? x - maxWidth / 2
      : align === "right"
        ? x - maxWidth
        : x;
  const font = /bold|semibold/i.test(field.font_family || "")
    ? "Helvetica-Bold"
    : "Helvetica";

  document
    .font(font)
    .fontSize(fontSize)
    .fillColor(
      /^#[0-9a-f]{6}$/i.test(field.color || "") ? field.color : "#111923",
    )
    .text(value, left, y - fontSize * 0.5, {
      width: maxWidth,
      align,
      lineBreak: false,
      ellipsis: true,
    });
}

async function drawQrField(
  document,
  field,
  attendee,
  template,
  pageWidth,
  pageHeight,
) {
  const configuredSize = field.font_size;
  const size = Math.max(24, (configuredSize / template.width) * pageWidth);
  const centerX = (field.x / template.width) * pageWidth;
  const centerY = (field.y / template.height) * pageHeight;
  const qr = await QRCode.toBuffer(attendee.verifyUrl, {
    errorCorrectionLevel: "H",
    margin: 1,
    width: 720,
    color: { dark: "#111923", light: "#ffffff" },
  });
  const left = centerX - size / 2;
  const top = centerY - size / 2;
  document.rect(left - 1, top - 1, size + 2, size + 2).fill("#ffffff");
  document.image(qr, left, top, { width: size, height: size });
}

export async function renderPdf(filePath, templateBytes, template, attendee) {
  const pageHeight = (template.height / template.width) * PAGE_WIDTH;
  const document = new PDFDocument({
    autoFirstPage: false,
    compress: true,
    info: { Title: `Certificate ${attendee.certId}`, Author: "CNCF Peshawar" },
  });
  const output = createWriteStream(filePath);
  document.pipe(output);
  document.addPage({ size: [PAGE_WIDTH, pageHeight], margin: 0 });
  document.image(templateBytes, 0, 0, {
    width: PAGE_WIDTH,
    height: pageHeight,
  });

  for (const field of template.fields) {
    drawField(document, field, attendee, template, PAGE_WIDTH, pageHeight);
  }

  const qrField = findEnabledQrField(template.fields);
  if (attendee.verifyUrl && qrField) {
    await drawQrField(
      document,
      qrField,
      attendee,
      template,
      PAGE_WIDTH,
      pageHeight,
    );
  }

  document.end();
  await new Promise((resolve, reject) => {
    output.on("finish", resolve);
    output.on("error", reject);
    document.on("error", reject);
  });
}

export async function makeArchive(workDirectory, attendees, manifest) {
  const csv = [
    "cert_id,recipient_name,recipient_email,role,date,verify_url,issuer",
    ...manifest.map((row) =>
      [
        row.cert_id,
        row.recipient_name,
        row.recipient_email,
        row.role,
        row.date,
        row.verify_url,
        row.issuer,
      ]
        .map(csvCell)
        .join(","),
    ),
  ].join("\r\n");
  await writeFile(
    path.join(workDirectory, "manifest.csv"),
    `${csv}\r\n`,
    "utf8",
  );
  await writeFile(
    path.join(workDirectory, "manifest.json"),
    JSON.stringify({ version: 1, certificates: manifest }, null, 2),
    "utf8",
  );

  const zipPath = path.join(workDirectory, "certificates.zip");
  const output = createWriteStream(zipPath);
  const archive = archiver("zip", { zlib: { level: 9 } });
  archive.pipe(output);
  archive.directory(
    path.join(workDirectory, "individual", "pdf"),
    "individual/pdf",
  );
  archive.file(path.join(workDirectory, "manifest.csv"), {
    name: "manifest.csv",
  });
  archive.file(path.join(workDirectory, "manifest.json"), {
    name: "manifest.json",
  });
  await archive.finalize();
  await new Promise((resolve, reject) => {
    output.on("close", resolve);
    output.on("error", reject);
    archive.on("error", reject);
  });
  if (attendees.length !== manifest.length)
    throw new Error("Manifest row count mismatch.");
  return zipPath;
}

function validatePayload(payload, jobId) {
  if (
    ![1, 2].includes(payload?.version) ||
    payload.job_id !== jobId ||
    !Array.isArray(payload.attendees) ||
    payload.attendees.length < 1 ||
    payload.attendees.length > 400 ||
    !payload.template ||
    !Array.isArray(payload.template.fields) ||
    typeof payload.callback_url !== "string"
  ) {
    throw new Error("The private batch payload is invalid.");
  }
  return payload;
}

async function main() {
  requireEnvironment();
  const jobId = validateJobId(process.env.JOB_ID);
  const workDirectory = await mkdir(
    path.join(tmpdir(), `${jobId}-${process.pid}`),
    { recursive: true },
  ).then(() => path.join(tmpdir(), `${jobId}-${process.pid}`));
  let payload;

  try {
    const auth = await authorizeB2();
    payload = validatePayload(
      JSON.parse(
        (await downloadB2(auth, `batch-inputs/${jobId}.json`)).toString("utf8"),
      ),
      jobId,
    );
    await callback({ status: "running", processed: 0 }, payload.callback_url);
    const templateBytes = await readTemplate(auth, payload.template);
    const pdfDirectory = path.join(workDirectory, "individual", "pdf");
    await mkdir(pdfDirectory, { recursive: true });
    const manifest = [];
    const generationDate = formatCertificateDate();
    const legacyDatesWereDefaulted =
      payload.version === 1 &&
      payload.attendees.every(
        (attendee) => !attendee.date || attendee.date === payload.event?.date,
      );

    for (let index = 0; index < payload.attendees.length; index += 1) {
      const attendee = payload.attendees[index];
      if (
        typeof attendee.certId !== "string" ||
        typeof attendee.name !== "string" ||
        typeof attendee.verifyUrl !== "string"
      ) {
        throw new Error("A private attendee record is invalid.");
      }
      const resolvedAttendee = {
        ...attendee,
        date: resolveCertificateDate(
          attendee.date,
          generationDate,
          legacyDatesWereDefaulted,
        ),
      };
      const filename = `${safeFilename(attendee.certId)}_${safeFilename(attendee.name)}.pdf`;
      await renderPdf(
        path.join(pdfDirectory, filename),
        templateBytes,
        payload.template,
        resolvedAttendee,
      );
      manifest.push({
        cert_id: attendee.certId,
        recipient_name: attendee.name,
        recipient_email: attendee.email || "",
        role: attendee.role || "Attendee",
        date: resolvedAttendee.date,
        verify_url: attendee.verifyUrl,
        issuer: payload.issuer,
      });
      await callback(
        { status: "progress", processed: index + 1 },
        payload.callback_url,
      );
    }

    const zipPath = await makeArchive(
      workDirectory,
      payload.attendees,
      manifest,
    );
    const outputKey = `batch-exports/${jobId}.zip`;
    await uploadB2(auth, outputKey, zipPath, "application/zip");
    await callback(
      {
        status: "completed",
        output_key: outputKey,
        certificates: manifest.map((row) => ({
          certId: row.cert_id,
          recipientName: row.recipient_name,
          role: row.role,
          date: row.date,
        })),
      },
      payload.callback_url,
    );
    console.log(
      JSON.stringify({
        message: "batch completed",
        jobId,
        count: manifest.length,
      }),
    );
  } catch (error) {
    if (payload?.callback_url) {
      try {
        await callback({ status: "failed" }, payload.callback_url);
      } catch {
        // The original failure remains authoritative; never print attendee data.
      }
    }
    console.error(
      JSON.stringify({
        message: "batch failed",
        jobId: process.env.JOB_ID || "invalid",
        error:
          error instanceof Error ? error.message : "Unknown rendering error",
      }),
    );
    process.exitCode = 1;
  } finally {
    await rm(workDirectory, { recursive: true, force: true });
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
