// ═══════════════════════════════════════════════════════════
//  SmartScrapeAI — C3 Storage (Cloudflare R2 / S3-compatible)
//  Opsional: sync scrapers.json ke bucket R2
//  Set env vars untuk mengaktifkan:
//    C3_ENDPOINT  = https://<account-id>.r2.cloudflarestorage.com
//    C3_BUCKET    = nama-bucket
//    C3_ACCESS_KEY = access key R2
//    C3_SECRET_KEY  = secret key R2
//    C3_PUBLIC_URL  = https://pub.example.com (opsional, untuk public access)
// ═══════════════════════════════════════════════════════════

const path = require("path");
const fs   = require("fs");
const axios = require("axios");
const crypto = require("crypto");

const C3_ENDPOINT   = process.env.C3_ENDPOINT   || "";
const C3_BUCKET     = process.env.C3_BUCKET      || "smartscrapeai";
const C3_ACCESS_KEY = process.env.C3_ACCESS_KEY  || "";
const C3_SECRET_KEY = process.env.C3_SECRET_KEY  || "";
const C3_PUBLIC_URL = process.env.C3_PUBLIC_URL  || "";
const C3_FILE_KEY   = process.env.C3_FILE_KEY    || "scrapers.json";

function isConfigured() {
  return !!(C3_ENDPOINT && C3_ACCESS_KEY && C3_SECRET_KEY);
}

// ── AWS Signature v4 (untuk R2/S3) ────────────────────────────
function sign(key, msg) {
  return crypto.createHmac("sha256", key).update(msg).digest();
}

function getSignatureKey(secretKey, dateStamp, region, service) {
  const kDate    = sign("AWS4" + secretKey, dateStamp);
  const kRegion  = sign(kDate, region);
  const kService = sign(kRegion, service);
  return sign(kService, "aws4_request");
}

function buildAuthHeader({ method, bucket, key, region, endpoint, accessKey, secretKey, body = "", contentType = "application/json" }) {
  const now         = new Date();
  const amzDate     = now.toISOString().replace(/[:-]|\.\d{3}/g, "").replace("Z", "Z").slice(0, 16) + "00Z";
  const dateStamp   = amzDate.slice(0, 8);
  const host        = new URL(endpoint).host;
  const canonicalUri= `/${bucket}/${key}`;
  const payloadHash = crypto.createHash("sha256").update(body).digest("hex");

  const canonicalHeaders = `content-type:${contentType}\nhost:${host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders    = "content-type;host;x-amz-content-sha256;x-amz-date";
  const canonicalRequest = `${method}\n${canonicalUri}\n\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;

  const credentialScope  = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign     = `AWS4-HMAC-SHA256\n${amzDate}\n${credentialScope}\n${crypto.createHash("sha256").update(canonicalRequest).digest("hex")}`;
  const signingKey       = getSignatureKey(secretKey, dateStamp, region, "s3");
  const signature        = crypto.createHmac("sha256", signingKey).update(stringToSign).digest("hex");

  return {
    Authorization:         `AWS4-HMAC-SHA256 Credential=${accessKey}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    "x-amz-date":          amzDate,
    "x-amz-content-sha256": payloadHash,
    "Content-Type":        contentType,
  };
}

// ── Upload file ke R2 ─────────────────────────────────────────
async function uploadToC3(data, filename = C3_FILE_KEY) {
  if (!isConfigured()) throw new Error("C3 Storage belum dikonfigurasi. Set C3_ENDPOINT, C3_ACCESS_KEY, C3_SECRET_KEY di .env");

  const body        = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  const region      = "auto"; // R2 uses "auto"
  const headers     = buildAuthHeader({
    method:      "PUT",
    bucket:      C3_BUCKET,
    key:         filename,
    region,
    endpoint:    C3_ENDPOINT,
    accessKey:   C3_ACCESS_KEY,
    secretKey:   C3_SECRET_KEY,
    body,
    contentType: "application/json",
  });

  const url = `${C3_ENDPOINT}/${C3_BUCKET}/${filename}`;
  const res = await axios.put(url, body, { headers, timeout: 30000 });

  return {
    success:   true,
    filename,
    bucket:    C3_BUCKET,
    publicUrl: C3_PUBLIC_URL ? `${C3_PUBLIC_URL}/${filename}` : null,
    etag:      res.headers.etag || null,
    bytes:     Buffer.byteLength(body, "utf8"),
    uploadedAt: new Date().toISOString(),
  };
}

// ── Download file dari R2 ─────────────────────────────────────
async function downloadFromC3(filename = C3_FILE_KEY) {
  if (!isConfigured()) throw new Error("C3 Storage belum dikonfigurasi");

  const region  = "auto";
  const headers = buildAuthHeader({
    method:      "GET",
    bucket:      C3_BUCKET,
    key:         filename,
    region,
    endpoint:    C3_ENDPOINT,
    accessKey:   C3_ACCESS_KEY,
    secretKey:   C3_SECRET_KEY,
    body:        "",
    contentType: "application/json",
  });

  const url = `${C3_ENDPOINT}/${C3_BUCKET}/${filename}`;
  const res = await axios.get(url, { headers, timeout: 30000 });
  return typeof res.data === "string" ? JSON.parse(res.data) : res.data;
}

// ── List files di bucket ──────────────────────────────────────
async function listC3Files(prefix = "") {
  if (!isConfigured()) throw new Error("C3 Storage belum dikonfigurasi");

  const region   = "auto";
  const key      = "";
  const queryStr = prefix ? `?prefix=${encodeURIComponent(prefix)}` : "?list-type=2";
  const headers  = buildAuthHeader({
    method:      "GET",
    bucket:      C3_BUCKET,
    key,
    region,
    endpoint:    C3_ENDPOINT,
    accessKey:   C3_ACCESS_KEY,
    secretKey:   C3_SECRET_KEY,
    body:        "",
    contentType: "application/xml",
  });

  const url = `${C3_ENDPOINT}/${C3_BUCKET}/${queryStr}`;
  const res = await axios.get(url, { headers, timeout: 15000 });

  // Simple XML parse for file list
  const matches = [...(res.data?.toString().matchAll(/<Key>([^<]+)<\/Key>/g) || [])];
  return matches.map(m => m[1]);
}

// ── Delete file dari R2 ───────────────────────────────────────
async function deleteFromC3(filename) {
  if (!isConfigured()) throw new Error("C3 Storage belum dikonfigurasi");

  const region  = "auto";
  const headers = buildAuthHeader({
    method:      "DELETE",
    bucket:      C3_BUCKET,
    key:         filename,
    region,
    endpoint:    C3_ENDPOINT,
    accessKey:   C3_ACCESS_KEY,
    secretKey:   C3_SECRET_KEY,
    body:        "",
    contentType: "application/json",
  });

  const url = `${C3_ENDPOINT}/${C3_BUCKET}/${filename}`;
  await axios.delete(url, { headers, timeout: 15000 });
  return { success: true, deleted: filename };
}

module.exports = {
  isConfigured,
  uploadToC3,
  downloadFromC3,
  listC3Files,
  deleteFromC3,
  config: () => ({
    configured:  isConfigured(),
    endpoint:    C3_ENDPOINT ? C3_ENDPOINT.replace(/\/\/.*?@/, "//***@") : null,
    bucket:      C3_BUCKET,
    fileKey:     C3_FILE_KEY,
    publicUrl:   C3_PUBLIC_URL || null,
    hasKeys:     !!(C3_ACCESS_KEY && C3_SECRET_KEY),
  }),
};
