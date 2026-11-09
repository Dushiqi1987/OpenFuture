/**
 * Dependency-free frontmatter reader/writer for the small YAML subset used by
 * pi-llm-wiki pages. The adapter only trusts scalar control fields (status,
 * state, project_id, type, title) plus the canonical `sources` and `evidence`
 * arrays it writes itself; everything else stays opaque.
 */

const SCALAR_SPECIAL = /[:#\[\]{}&*!|>'"%@`]/;
const NUMBER_LIKE = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/;

function parseScalar(raw) {
  const value = raw.trim();
  if (value === "") return "";
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    if (value.startsWith('"')) {
      try {
        return JSON.parse(value);
      } catch {
        return value.slice(1, -1);
      }
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value === "null" || value === "~") return null;
  if (value === "true") return true;
  if (value === "false") return false;
  if (NUMBER_LIKE.test(value)) return Number(value);
  if (value.startsWith("[") && value.endsWith("]")) {
    const inner = value.slice(1, -1).trim();
    if (!inner) return [];
    return splitInlineList(inner).map((item) => parseScalar(item));
  }
  return value;
}

function splitInlineList(inner) {
  const items = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < inner.length; i += 1) {
    const char = inner[i];
    if (quote) {
      current += char;
      if (char === quote && inner[i - 1] !== "\\") quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (current.trim()) items.push(current.trim());
  return items;
}

function indentOf(line) {
  const match = /^[ \t]*/.exec(line);
  return match ? match[0].length : 0;
}

function isIgnorable(line) {
  const trimmed = line.trim();
  return trimmed === "" || trimmed.startsWith("#");
}

function parseBlock(lines, start, indent) {
  let index = start;
  while (index < lines.length && isIgnorable(lines[index])) index += 1;
  if (index >= lines.length) return { value: null, next: index };

  const first = lines[index];
  const firstIndent = indentOf(first);
  if (firstIndent < indent) return { value: null, next: index };

  if (/^[ \t]*-[ \t]+/.test(first)) {
    const items = [];
    while (index < lines.length) {
      if (isIgnorable(lines[index])) {
        index += 1;
        continue;
      }
      const line = lines[index];
      const lineIndent = indentOf(line);
      if (lineIndent < firstIndent) break;
      if (lineIndent > firstIndent) {
        index += 1;
        continue;
      }
      const match = /^[ \t]*-[ \t]+(.*)$/.exec(line);
      if (!match) break;
      const rest = match[1].trim();
      if (rest === "") {
        const nested = parseBlock(lines, index + 1, firstIndent + 2);
        items.push(nested.value);
        index = nested.next;
        continue;
      }
      const keyMatch = /^([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(rest);
      if (keyMatch) {
        const object = {};
        const key = keyMatch[1];
        const rawValue = keyMatch[2].trim();
        object[key] = rawValue === "" ? null : parseScalar(rawValue);
        index += 1;
        while (index < lines.length) {
          if (isIgnorable(lines[index])) {
            index += 1;
            continue;
          }
          const childLine = lines[index];
          const childIndent = indentOf(childLine);
          if (childIndent <= firstIndent) break;
          const childMatch = /^[ \t]+([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(childLine);
          if (!childMatch) break;
          const childKey = childMatch[1];
          const childRaw = childMatch[2].trim();
          if (childRaw === "") {
            const nested = parseBlock(lines, index + 1, childIndent + 2);
            object[childKey] = nested.value;
            index = nested.next;
          } else {
            object[childKey] = parseScalar(childRaw);
            index += 1;
          }
        }
        items.push(object);
        continue;
      }
      items.push(parseScalar(rest));
      index += 1;
    }
    return { value: items, next: index };
  }

  const object = {};
  while (index < lines.length) {
    if (isIgnorable(lines[index])) {
      index += 1;
      continue;
    }
    const line = lines[index];
    const lineIndent = indentOf(line);
    if (lineIndent < firstIndent) break;
    const match = /^[ \t]*([A-Za-z0-9_.-]+):[ \t]*(.*)$/.exec(line);
    if (!match) break;
    const key = match[1];
    const raw = match[2].trim();
    if (raw === "") {
      const nested = parseBlock(lines, index + 1, lineIndent + 1);
      object[key] = nested.value;
      index = nested.next;
    } else {
      object[key] = parseScalar(raw);
      index += 1;
    }
  }
  return { value: object, next: index };
}

/**
 * @param {string} content
 * @returns {{ok: true, data: Record<string, unknown>, body: string, yaml: string} | {ok: false, reason: string, body: string}}
 */
export function parseFrontmatter(content) {
  const normalized = String(content ?? "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---\n")) {
    return { ok: false, reason: "missing opening frontmatter delimiter", body: normalized };
  }
  const lines = normalized.split("\n");
  if (lines[0] !== "---") {
    return { ok: false, reason: "opening frontmatter delimiter must be its own line", body: normalized };
  }
  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i] === "---") {
      closing = i;
      break;
    }
  }
  if (closing === -1) {
    return { ok: false, reason: "missing closing frontmatter delimiter", body: normalized };
  }
  const yaml = lines.slice(1, closing).join("\n");
  const body = lines.slice(closing + 1).join("\n").replace(/^\n/, "").replace(/\n$/, "");
  const parsed = parseBlock(lines.slice(1, closing), 0, 0);
  if (parsed.value !== null && (typeof parsed.value !== "object" || Array.isArray(parsed.value))) {
    return { ok: false, reason: "frontmatter must be a mapping", body };
  }
  return { ok: true, data: parsed.value ?? {}, body, yaml };
}

function needsQuoting(value) {
  if (value === "") return true;
  if (SCALAR_SPECIAL.test(value)) return true;
  if (/^\s|\s$/.test(value)) return true;
  if (value === "true" || value === "false" || value === "null" || value === "~") return true;
  if (NUMBER_LIKE.test(value)) return true;
  return false;
}

function renderScalar(value) {
  if (value === null || value === undefined) return "null";
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  const text = String(value);
  return needsQuoting(text) ? JSON.stringify(text) : text;
}

function renderBlock(key, value, indent) {
  const pad = " ".repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}${key}: []\n`;
    let out = `${pad}${key}:\n`;
    for (const item of value) {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        const entries = Object.entries(item);
        if (entries.length === 0) {
          out += `${pad}  - {}\n`;
          continue;
        }
        const [firstKey, firstValue] = entries[0];
        out += `${pad}  - ${firstKey}: ${renderScalar(firstValue)}\n`;
        for (const [childKey, childValue] of entries.slice(1)) {
          out += renderBlock(childKey, childValue, indent + 4);
        }
      } else {
        out += `${pad}  - ${renderScalar(item)}\n`;
      }
    }
    return out;
  }
  if (value && typeof value === "object") {
    let out = `${pad}${key}:\n`;
    for (const [childKey, childValue] of Object.entries(value)) {
      out += renderBlock(childKey, childValue, indent + 2);
    }
    return out;
  }
  return `${pad}${key}: ${renderScalar(value)}\n`;
}

/** Serialize a page with a stable key order and a single blank line before the body. */
export function renderFrontmatter(data, body) {
  let out = "---\n";
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    out += renderBlock(key, value, 0);
  }
  out += "---\n";
  const normalizedBody = String(body ?? "").replace(/\r\n?/g, "\n").replace(/\n*$/, "");
  return normalizedBody ? `${out}\n${normalizedBody}\n` : out;
}

/** Read the control fields of a page without trusting nested structures. */
export function readPageMeta(content) {
  const parsed = parseFrontmatter(content);
  if (!parsed.ok) return { ok: false, reason: parsed.reason, data: {}, body: parsed.body };
  return { ok: true, data: parsed.data, body: parsed.body, yaml: parsed.yaml };
}

export function scalarString(data, key) {
  const value = data?.[key];
  return typeof value === "string" ? value : null;
}
