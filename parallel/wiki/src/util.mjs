import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";

export function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function shortHash(value, length = 12) {
  return sha256(value).slice(0, length);
}

export function nowIso() {
  return new Date().toISOString();
}

export function todayUtc() {
  return new Date().toISOString().slice(0, 10);
}

export async function ensureDir(dir) {
  await mkdir(dir, { recursive: true });
}

export async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}

/** Write JSON atomically (tmp + rename) so a crash cannot leave half a state file. */
export async function writeJson(file, value) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  await rename(tmp, file);
}

export async function writeText(file, text) {
  await ensureDir(path.dirname(file));
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, "utf8");
  await rename(tmp, file);
}

export async function readText(file) {
  try {
    return await readFile(file, "utf8");
  } catch {
    return null;
  }
}

export async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/** Physical containment check; the vault root itself is allowed. */
export function isWithin(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function toPosix(value) {
  return value.split(path.sep).join("/");
}

/** Keep ids filesystem-safe and stable for slugs and evidence ids. */
export function safeId(value, fallback = "item") {
  const text = String(value ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}._-]+/gu, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "")
    .slice(0, 80);
  return text || fallback;
}

/** Windows-safe page slug, mirroring pi-llm-wiki's slug rules closely enough. */
export function pageSlug(title) {
  const reserved = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
  let slug = String(title ?? "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}\s-]+/gu, "")
    .trim()
    .replace(/[\s-]+/g, "-")
    .slice(0, 80);
  if (!slug) slug = "page";
  if (slug === "index" || slug === "log") slug = `${slug}-page`;
  if (reserved.test(slug)) slug = `_${slug}`;
  return slug;
}

export function parseSourceId(text) {
  const match = /Source captured:\s*(SRC-\d{4}-\d{2}-\d{2}-\d{3})/i.exec(String(text ?? ""));
  return match ? match[1] : null;
}

export function parseLocator(locator) {
  if (!locator || typeof locator !== "object") return null;
  const { type, start, end, page, line, lineStart, lineEnd } = locator;
  if (type === "char_range" && Number.isInteger(start) && Number.isInteger(end) && end >= start) {
    return { type: "char_range", start, end };
  }
  if (type === "page" && Number.isInteger(page) && page > 0) {
    return { type: "page", page };
  }
  if (type === "line_range" && Number.isInteger(lineStart) && lineStart > 0) {
    return { type: "line_range", lineStart, lineEnd: Number.isInteger(lineEnd) ? lineEnd : lineStart };
  }
  if (Number.isInteger(line) && line > 0) return { type: "line_range", lineStart: line, lineEnd: line };
  return null;
}

export function unique(values) {
  return [...new Set(values)];
}
