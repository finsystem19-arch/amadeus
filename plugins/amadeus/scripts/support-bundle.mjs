#!/usr/bin/env node
import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const SECRET_PATTERNS = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bsk-[A-Za-z0-9_-]{12,}\b/g,
  /\b(?:api[_-]?key|token|password|secret)\s*[:=]\s*[^\s,;]+/gi,
];
const PATH_PATTERNS = [
  /\b[A-Za-z]:\\Users\\[^\\\s]+/g,
  /\/Users\/[^/\s]+/g,
  /\/home\/[^/\s]+/g,
];

export function redactSupportText(value) {
  let text = String(value ?? "");
  for (const pattern of SECRET_PATTERNS) text = text.replace(pattern, "[REDACTED_SECRET]");
  for (const pattern of PATH_PATTERNS) text = text.replace(pattern, "[REDACTED_HOME]");
  return text;
}
export function previewSupportBundle(input = {}) {
  if (input.userInitiated !== true) {
    throw Object.assign(new Error("Support-bundle preview must be user initiated."), { code: "USER_INITIATION_REQUIRED" });
  }
  const entries = (input.entries || []).map((entry) => ({
    name: basename(String(entry.name || "entry.txt")),
    content: redactSupportText(entry.content),
  }));
  return {
    schemaVersion: 1,
    previewOnly: true,
    uploaded: false,
    uploadSupported: false,
    entries,
    notice: "Review locally. Amadeus never uploads support bundles.",
  };
}

export function writeApprovedSupportBundle(path, preview, approval = false) {
  if (approval !== true || preview?.previewOnly !== true || preview?.uploaded !== false) {
    throw Object.assign(new Error("Writing a support bundle requires approval of a local preview."), { code: "SUPPORT_BUNDLE_APPROVAL_REQUIRED" });
  }
  const payload = { ...preview, previewOnly: false, writtenLocally: true, uploaded: false };
  writeFileSync(resolve(path), `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return payload;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  const files = process.argv.slice(2);
  const entries = files.map((path) => ({ name: basename(path), content: readFileSync(resolve(path), "utf8") }));
  process.stdout.write(`${JSON.stringify(previewSupportBundle({ userInitiated: true, entries }), null, 2)}\n`);
}

