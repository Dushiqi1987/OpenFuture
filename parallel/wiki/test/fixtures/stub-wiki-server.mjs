#!/usr/bin/env node
/**
 * Deterministic stand-in for pi-llm-wiki 0.12.5's stdio MCP server.
 *
 * It intentionally mirrors the observable 0.12.5 contract needed by the
 * adapter (newline JSON-RPC, text-only tool results, vault layout, skeleton
 * source pages, unfiltered recall) without requiring a model, network, or the
 * published npm package. The real package can be substituted at runtime with
 * PI_LLM_WIKI_SERVER; test/contract.test.mjs is gated on that variable.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SERVER_VERSION = "0.12.5-stub";
const stderr = (line) => process.stderr.write(`${line}\n`);

const TOOLS = [
  ["wiki_bootstrap", { topic: { type: "string" }, mode: { type: "string" } }],
  ["wiki_capture_source", { title: { type: "string" }, text: { type: "string" } }],
  ["wiki_ingest", { source_id: { type: "string" }, batch_size: { type: "number" } }],
  ["wiki_status", {}],
  ["wiki_lint", { auto_fix: { type: "boolean" } }],
  ["wiki_search", { query: { type: "string" }, type: { type: "string" } }],
  ["wiki_recall", { query: { type: "string" }, max_results: { type: "number" } }],
  ["wiki_ensure_page", { type: { type: "string" }, title: { type: "string" }, content: { type: "string" } }],
  ["wiki_rebuild_meta", {}],
  ["wiki_retro", {}],
  ["wiki_observe", {}],
  ["wiki_log_event", {}],
  ["wiki_reindex", {}],
  ["wiki_reindex_embeddings", {}],
];

function rootDir() {
  return path.resolve(process.env.WIKI_ROOT || process.cwd());
}
function dotWiki() {
  return path.join(rootDir(), ".llm-wiki");
}
function paths() {
  const dot = dotWiki();
  return {
    root: rootDir(),
    dot,
    rawSources: path.join(dot, "raw", "sources"),
    wiki: path.join(dot, "wiki"),
    meta: path.join(dot, "meta"),
    outputs: path.join(dot, "outputs"),
    config: path.join(dot, "config.json"),
    personal: path.join(process.env.WIKI_HOME || os.homedir(), ".llm-wiki", "wiki"),
  };
}
async function exists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}
async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch {
    return fallback;
  }
}
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
async function listDir(dir) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}
async function walkMarkdown(dir) {
  const out = [];
  for (const entry of await listDir(dir)) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walkMarkdown(full)));
    else if (entry.isFile() && entry.name.endsWith(".md")) out.push(full);
  }
  return out;
}

/** Independent minimal frontmatter reader (do not share the adapter's parser). */
function parsePage(content) {
  const text = content.replace(/\r\n?/g, "\n");
  if (!text.startsWith("---\n")) return { data: {}, body: text };
  const end = text.indexOf("\n---\n", 3);
  if (end === -1) return { data: {}, body: text };
  const yaml = text.slice(4, end);
  const body = text.slice(end + 5).replace(/^\n/, "");
  const data = {};
  for (const line of yaml.split("\n")) {
    if (!line || line.startsWith(" ") || line.startsWith("#")) continue;
    const match = /^([A-Za-z0-9_.-]+):\s*(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (value.startsWith('"') && value.endsWith('"')) {
      try {
        value = JSON.parse(value);
      } catch {
        value = value.slice(1, -1);
      }
    } else if (value === "true") value = true;
    else if (value === "false") value = false;
    else if (/^-?\d+$/.test(value)) value = Number(value);
    data[match[1]] = value;
  }
  return { data, body };
}
function renderPage(data, body) {
  const lines = ["---"];
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (typeof value === "string" && /[:#\[\]{}]/.test(value)) {
      lines.push(`${key}: ${JSON.stringify(value)}`);
    } else {
      lines.push(`${key}: ${value}`);
    }
  }
  lines.push("---");
  return `${lines.join("\n")}\n\n${body.replace(/\n*$/, "")}\n`;
}

async function rebuildRegistry(p) {
  const pages = [];
  for (const file of await walkMarkdown(p.wiki)) {
    const relative = path.relative(p.wiki, file).split(path.sep).join("/");
    if (relative === "index.md" || relative === "log.md") continue;
    const parsed = parsePage(await readFile(file, "utf8"));
    pages.push({
      id: relative.replace(/\.md$/, ""),
      type: parsed.data.type ?? null,
      title: parsed.data.title ?? relative,
      status: parsed.data.status ?? null,
      path: file,
    });
  }
  pages.sort((a, b) => a.id.localeCompare(b.id));
  await writeJson(path.join(p.meta, "registry.json"), {
    version: 1,
    updatedAt: new Date().toISOString(),
    pages,
  });
  return pages;
}

async function requireVault() {
  const p = paths();
  if (!(await exists(p.config))) throw new Error("No wiki found — run wiki_bootstrap first.");
  return p;
}

function textResult(text, isError = false) {
  return { content: [{ type: "text", text }], isError };
}

async function bootstrap(args) {
  const p = paths();
  for (const dir of [
    p.rawSources,
    path.join(p.dot, "raw", "assets"),
    path.join(p.wiki, "sources"),
    path.join(p.wiki, "entities"),
    path.join(p.wiki, "concepts"),
    path.join(p.wiki, "syntheses"),
    path.join(p.wiki, "analyses"),
    path.join(p.wiki, "requirements"),
    p.meta,
    p.outputs,
  ]) {
    await mkdir(dir, { recursive: true });
  }
  const config = (await readJson(p.config)) ?? {};
  const next = {
    ...config,
    topic: args.topic ?? config.topic ?? path.basename(p.root),
    mode: args.mode ?? config.mode ?? "personal",
    knowledge_format: config.knowledge_format ?? "legacy",
    created_at: config.created_at ?? new Date().toISOString(),
    server: `pi-llm-wiki@${SERVER_VERSION}`,
  };
  await writeJson(p.config, next);
  return textResult(`✅ Wiki bootstrapped for "${next.topic}" (${next.mode}) at ${p.root}`);
}

async function captureSource(args) {
  const p = await requireVault();
  const text = typeof args.text === "string" ? args.text : "";
  if (!text.trim()) throw new Error("wiki_capture_source requires non-empty text in the stub");
  const today = new Date().toISOString().slice(0, 10);
  let next = 1;
  for (const entry of await listDir(p.rawSources)) {
    const match = new RegExp(`^SRC-${today}-(\\d{3})$`).exec(entry.name);
    if (match) next = Math.max(next, Number(match[1]) + 1);
  }
  const id = `SRC-${today}-${String(next).padStart(3, "0")}`;
  const packetDir = path.join(p.rawSources, id);
  await mkdir(path.join(packetDir, "attachments"), { recursive: true });
  await writeFile(path.join(packetDir, "extracted.md"), text, "utf8");
  await writeJson(path.join(packetDir, "manifest.json"), {
    source_id: id,
    title: args.title ?? id,
    format: "text",
    captured: new Date().toISOString(),
    extracted_chars: text.length,
  });
  const skeleton = renderPage(
    {
      type: "source",
      title: args.title ?? id,
      format: "text",
      source_id: id,
      raw_path: `raw/sources/${id}/extracted.md`,
      captured: today,
      status: "skeleton",
    },
    [
      "## Summary",
      "",
      "## Key Takeaways",
      "",
      "## Entities Mentioned",
      "",
      "## Concepts Mentioned",
      "",
      "## Notable Quotes",
      "",
      "## Source Packet",
      "",
      `- raw_path: raw/sources/${id}/extracted.md`,
    ].join("\n"),
  );
  await mkdir(path.join(p.wiki, "sources"), { recursive: true });
  await writeFile(path.join(p.wiki, "sources", `${id}.md`), skeleton, "utf8");
  await rebuildRegistry(p);
  return textResult(`Source captured: ${id} (${text.length} chars)`);
}

async function ingest(args) {
  const p = await requireVault();
  const registry = (await readJson(path.join(p.meta, "registry.json"))) ?? { pages: [] };
  const pages = registry.pages ?? [];
  const packetIds = (await listDir(p.rawSources))
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("SRC-"))
    .map((entry) => entry.name)
    .sort();
  const ingested = new Set(
    pages.filter((page) => page.type === "source" && page.status && page.status !== "skeleton").map((page) => page.id.replace(/^sources\//, "")),
  );
  const pending = packetIds.filter((id) => !ingested.has(id));
  if (pending.length === 0) {
    return textResult("No uningested source packets. Capture a source first.");
  }
  const batch = pending.slice(0, Math.max(1, Math.min(5, Number(args.batch_size) || 5)));
  const lines = [
    "⚠️ No background LLM available (no model configured) — synthesize these sources yourself:",
    ...batch.map((id) => `- ${id}`),
    "",
    "For each source, read raw/sources/<id>/extracted.md and write the source page, then call wiki_rebuild_meta.",
  ];
  return textResult(lines.join("\n"));
}

async function recall(args) {
  const p = await requireVault();
  const query = String(args.query ?? "").trim().toLowerCase();
  const max = Math.max(1, Math.min(20, Number(args.max_results) || 5));
  if (!query) return textResult(JSON.stringify({ query: args.query, matches: [] }, null, 2));
  const terms = query.split(/\s+/).filter(Boolean);
  const results = [];
  const search = async (dir, vaultLabel) => {
    for (const file of await walkMarkdown(dir)) {
      const content = await readFile(file, "utf8");
      const parsed = parsePage(content);
      const haystack = `${parsed.data.title ?? ""}\n${parsed.body}`.toLowerCase();
      if (!terms.some((term) => haystack.includes(term))) continue;
      let score = 0;
      for (const term of terms) {
        const titleHits = String(parsed.data.title ?? "").toLowerCase().split(term).length - 1;
        const bodyHits = haystack.split(term).length - 1;
        score += titleHits * 3 + bodyHits;
      }
      const relative = path.relative(p.wiki, file).split(path.sep).join("/");
      const id = vaultLabel === "personal" ? `personal/${relative.replace(/\.md$/, "")}` : relative.replace(/\.md$/, "");
      results.push({
        id,
        title: parsed.data.title ?? relative,
        type: parsed.data.type ?? null,
        // Deliberately untrusted: the adapter must rebuild previews locally.
        preview: `SERVER_PREVIEW_SENTINEL ${parsed.body.replace(/^#+\s*/gm, "").replace(/\s+/g, " ").trim().slice(0, 180)}`,
        path: file,
        score,
        ...(vaultLabel === "personal" ? { vaultLabel: "personal" } : {}),
      });
    }
  };
  await search(p.wiki, "project");
  if (await exists(p.personal)) await search(p.personal, "personal");
  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return textResult(JSON.stringify({ query: args.query, matches: results.slice(0, max) }, null, 2));
}

async function status() {
  const p = await requireVault();
  const config = (await readJson(p.config)) ?? {};
  const pages = await rebuildRegistry(p);
  const byType = {};
  for (const page of pages) byType[page.type ?? "unknown"] = (byType[page.type ?? "unknown"] ?? 0) + 1;
  return textResult(
    JSON.stringify(
      {
        topic: config.topic,
        mode: config.mode,
        totalPages: pages.length,
        byType,
        health: "ok",
        lastUpdated: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
}

async function lint() {
  const p = await requireVault();
  const pages = await rebuildRegistry(p);
  const revoked = pages.filter((page) => page.status === "revoked").length;
  const skeleton = pages.filter((page) => page.status === "skeleton").length;
  const report = [
    `# Wiki Lint — ${new Date().toISOString().slice(0, 10)}`,
    "",
    `- pages: ${pages.length}`,
    `- skeleton: ${skeleton}`,
    `- revoked: ${revoked}`,
    `- orphans: 0`,
    `- missing pages: 0`,
  ].join("\n");
  await mkdir(p.outputs, { recursive: true });
  await writeFile(path.join(p.outputs, `lint-${new Date().toISOString().slice(0, 10)}.md`), `${report}\n`, "utf8");
  return textResult(report);
}

async function ensurePage(args) {
  const p = await requireVault();
  const type = String(args.type ?? "").trim();
  const title = String(args.title ?? "").trim();
  if (!type || !title) throw new Error("wiki_ensure_page requires type and title");
  const slug = title.toLowerCase().replace(/[^\p{Letter}\p{Number}\s-]+/gu, "").trim().replace(/\s+/g, "-");
  const folder = type === "synthesis" ? "syntheses" : `${type}s`;
  const file = path.join(p.wiki, folder, `${slug}.md`);
  if (await exists(file)) return textResult(`✅ Page already exists: \`${path.relative(p.root, file).split(path.sep).join("/")}\``);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(
    file,
    renderPage({ type, title, status: "draft" }, args.content ?? `# ${title}\n`),
    "utf8",
  );
  await rebuildRegistry(p);
  return textResult(`✅ Created ${path.relative(p.root, file).split(path.sep).join("/")}`);
}

async function search(args) {
  const p = await requireVault();
  const query = String(args.query ?? "").toLowerCase();
  const pages = (await rebuildRegistry(p)).filter((page) => !args.type || page.type === args.type);
  const matches = pages
    .filter((page) => `${page.title} ${page.id}`.toLowerCase().includes(query))
    .map((page) => ({ id: page.id, title: page.title, type: page.type }));
  return textResult(matches.length ? JSON.stringify({ matches }, null, 2) : `No pages found for "${args.query}"`);
}

async function dispatch(name, args) {
  switch (name) {
    case "wiki_bootstrap":
      return bootstrap(args);
    case "wiki_capture_source":
      return captureSource(args);
    case "wiki_ingest":
      return ingest(args);
    case "wiki_recall":
      return recall(args);
    case "wiki_status":
      return status();
    case "wiki_lint":
      return lint();
    case "wiki_ensure_page":
      return ensurePage(args);
    case "wiki_search":
      return search(args);
    case "wiki_rebuild_meta": {
      const p = await requireVault();
      const pages = await rebuildRegistry(p);
      return textResult(`Rebuilt metadata: ${pages.length} pages`);
    }
    case "wiki_log_event":
      return textResult("Event logged");
    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

function send(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newline;
  while ((newline = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, "").trim();
    buffer = buffer.slice(newline + 1);
    if (!line) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      continue;
    }
    void handle(message);
  }
});

async function handle(message) {
  const { id, method, params } = message;
  try {
    if (method === "initialize") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "llm-wiki", version: SERVER_VERSION },
        },
      });
      return;
    }
    if (method === "notifications/initialized") return;
    if (method === "tools/list") {
      send({
        jsonrpc: "2.0",
        id,
        result: {
          tools: TOOLS.map(([name, properties]) => ({
            name,
            description: `stub ${name}`,
            inputSchema: { type: "object", properties, additionalProperties: true },
          })),
        },
      });
      return;
    }
    if (method === "tools/call") {
      const name = params?.name;
      try {
        const result = await dispatch(name, params?.arguments ?? {});
        send({ jsonrpc: "2.0", id, result });
      } catch (error) {
        send({ jsonrpc: "2.0", id, result: textResult(error.message, true) });
      }
      return;
    }
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  } catch (error) {
    send({ jsonrpc: "2.0", id, error: { code: -32603, message: error.message } });
  }
}

stderr("🧠 LLM Wiki MCP Server running on stdio");
