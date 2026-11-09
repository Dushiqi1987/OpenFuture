import { resolve } from "node:path";
import { readCheckedJson, sha256, writeCheckedJson } from "./atomic-json.mjs";

export const SIDECAR_FORMAT_VERSION = 1;

function safeSegment(value) {
  const text = String(value ?? "");
  if (/^[A-Za-z0-9._-]{1,96}$/.test(text)) return text;
  return `sha256-${sha256(text).slice(0, 24)}`;
}

export function sidecarPath(storeRoot, projectId, sessionId) {
  return resolve(storeRoot, safeSegment(projectId), `${safeSegment(sessionId)}.acp-host.json`);
}

export function saveHostState(file, payload) {
  writeCheckedJson(file, {
    formatVersion: SIDECAR_FORMAT_VERSION,
    projectId: payload.projectId,
    sessionId: payload.sessionId,
    revision: payload.revision,
    updatedAt: new Date().toISOString(),
    state: payload.state,
    contentStore: payload.contentStore,
    revocations: payload.revocations,
    invalidatedBlocks: payload.invalidatedBlocks,
    stats: payload.stats ?? {},
  });
}

export function loadHostState(file, { projectId, sessionId }) {
  const read = readCheckedJson(file);
  if (!read.ok) return read;
  if (read.missing) return { ok: true, missing: true, value: undefined };

    const value = read.value;
  if (!value || value.formatVersion !== SIDECAR_FORMAT_VERSION) {
    return { ok: false, reason: "SIDECAR_FORMAT_VERSION_UNSUPPORTED" };
  }
  if (value.projectId !== projectId || value.sessionId !== sessionId) {
    return { ok: false, reason: "SIDECAR_IDENTITY_MISMATCH" };
  }
  return { ok: true, value };
}
