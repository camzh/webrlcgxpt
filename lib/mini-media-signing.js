const crypto = require("crypto");

const MINI_UPLOAD_PREFIX = "/uploads/";
const MINI_SIG_PARAM = "miniSig";

function isAbsoluteUrl(value) {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(value);
}

function toUrlObject(input) {
  const value = String(input || "").trim();
  if (!value) return null;
  try {
    return {
      url: new URL(value, "http://localhost"),
      absolute: isAbsoluteUrl(value)
    };
  } catch (error) {
    return null;
  }
}

function normalizeSignature(value) {
  return String(value || "").trim().toLowerCase();
}

function signMiniMediaPath(pathname, secret) {
  const key = String(secret || "");
  if (!key) return "";
  return crypto.createHmac("sha256", key).update(String(pathname || "")).digest("hex").slice(0, 32);
}

function appendMiniMediaSignature(input, secret) {
  const original = String(input || "").trim();
  if (!original || original.startsWith("data:")) return original;

  const parsed = toUrlObject(original);
  if (!parsed) return original;

  const { url, absolute } = parsed;
  if (!url.pathname.startsWith(MINI_UPLOAD_PREFIX)) return original;

  const signature = signMiniMediaPath(url.pathname, secret);
  if (!signature) return original;

  url.searchParams.set(MINI_SIG_PARAM, signature);
  return absolute ? url.toString() : `${url.pathname}${url.search}${url.hash}`;
}

function hasValidMiniMediaSignature(input, secret) {
  const original = String(input || "").trim();
  if (!original) return false;

  const parsed = toUrlObject(original);
  if (!parsed) return false;

  const { url } = parsed;
  if (!url.pathname.startsWith(MINI_UPLOAD_PREFIX)) return false;

  const signature = normalizeSignature(url.searchParams.get(MINI_SIG_PARAM));
  if (!signature) return false;

  const expected = signMiniMediaPath(url.pathname, secret);
  if (!expected || signature.length !== expected.length) return false;

  return crypto.timingSafeEqual(Buffer.from(signature, "utf8"), Buffer.from(expected, "utf8"));
}

module.exports = {
  appendMiniMediaSignature,
  hasValidMiniMediaSignature,
  signMiniMediaPath
};
