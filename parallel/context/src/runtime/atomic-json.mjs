import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function checksumOf(value) {
  return sha256(JSON.stringify(value));
}

/**
 * Atomic JSON write with a checksum envelope. This is intentionally sync: the
 * sidecar is small and the Pi context hook is synchronous.
 */
export function writeCheckedJson(file, value) {
  mkdirSync(dirname(file), { recursive: true });
  const envelope = { formatVersion: 1, checksum: checksumOf(value), value };
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(envelope, null, 2), "utf8");
    renameSync(tmp, file);
  } catch (error) {
    try {
      if (existsSync(tmp)) unlinkSync(tmp);
    } catch {
      // best effort cleanup only
    }
    throw error;
  }
}

export function readCheckedJson(file) {
  if (!existsSync(file)) {
    return { ok: true, missing: true, value: undefined };
  }
  let envelope;
  try {
    envelope = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, reason: `JSON_PARSE_FAILED: ${error.message}` };
  }
  if (!envelope || envelope.formatVersion !== 1 || typeof envelope.checksum !== "string") {
    return { ok: false, reason: "SIDECAR_ENVELOPE_INVALID" };
  }
  if (checksumOf(envelope.value) !== envelope.checksum) {
    return { ok: false, reason: "SIDECAR_CHECKSUM_MISMATCH" };
  }
  return { ok: true, value: envelope.value };
}
