import path from "node:path";
import { compileTopic } from "./compiler.mjs";
import { diffLines, renderUnifiedDiff, summarizeDiff } from "./diff.mjs";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import { parseJsonText } from "./mcp-client.mjs";
import { prepareProject, saveState } from "./vault.mjs";
import {
  ensureDir,
  isWithin,
  listDir,
  nowIso,
  pageSlug,
  parseSourceId,
  pathExists,
  readText,
  safeId,
  sha256,
  toPosix,
  writeText,
} from "./util.mjs";

/**
 * Project-scoped adapter around a real pi-llm-wiki 0.12.5 stdio server.
 *
 * Contract boundaries:
 * - raw/** is written only by the wiki server (wiki_capture_source);
 * - wiki/** is editable, so this adapter writes published/revoked pages there
 *   and then asks the server to rebuild metadata;
 * - recall/read results are filtered by physical vault containment plus the
 *   page's own status/state/project_id, so inactive or foreign pages can never
 *   be returned to the caller.
 */
export class WikiAdapter {
  constructor({ client, paths, state, projectId, topicName }) {
    this.client = client;
    this.paths = paths;
    this.state = state;
    this.projectId = projectId;
    this.topicName = topicName;
    this.drafts = new Map();
  }

  static async open({
    baseDir,
    projectId,
    topic,
    mode = "personal",
    serverPath,
    nodePath,
    timeoutMs = 60_000,
  }) {
    if (!projectId) throw new Error("projectId is required");
    const prepared = await prepareProject({
      baseDir,
      projectId,
      topic: topic ?? projectId,
      mode,
      serverPath,
      nodePath,
      timeoutMs,
    });
    const adapter = new WikiAdapter({
      client: prepared.client,
      paths: prepared.paths,
      state: prepared.state,
      projectId,
      topicName: topic ?? projectId,
    });
    adapter.bootstrapped = prepared.bootstrapped;
    return adapter;
  }

  async close() {
    await this.client.close();
  }

  async #save() {
    await saveState(this.paths.stateFile, this.state);
  }

  #topic(topicId) {
    const topic = this.state.topics[topicId];
    if (!topic) throw new Error(`unknown topic: ${topicId}`);
    return topic;
  }

  defineTopic({ id, title, thesis = "", keywords = [], sourceIds = [] }) {
    if (!id || !title) throw new Error("topic id and title are required");
    const existing = this.state.topics[id];
    const topic = {
      id,
      title,
      thesis,
      keywords: [...keywords],
      slug: existing?.slug ?? pageSlug(title),
      sourceIds: sourceIds.length > 0 ? [...sourceIds] : (existing?.sourceIds ?? []),
      status: existing?.status ?? "active",
      createdAt: existing?.createdAt ?? nowIso(),
      published: existing?.published ?? null,
      lastDraft: existing?.lastDraft ?? null,
    };
    this.state.topics[id] = topic;
    return topic;
  }

  async addSourceToTopic(topicId, logicalId) {
    const topic = this.#topic(topicId);
    if (!topic.sourceIds.includes(logicalId)) topic.sourceIds.push(logicalId);
    await this.#save();
    return topic;
  }

  async #listPacketIds() {
    const entries = await listDir(this.paths.rawSourcesDir);
    return new Set(
      entries
        .filter((entry) => entry.isDirectory() && /^SRC-\d{4}-\d{2}-\d{2}-\d{3}$/.test(entry.name))
        .map((entry) => entry.name),
    );
  }

  async captureSource({ logicalId, title, text, revision, metadata = {} }) {
    if (!logicalId) throw new Error("logicalId is required");
    if (!title) throw new Error("title is required");
    if (typeof text !== "string" || text.trim() === "") throw new Error("text is required");
    const hash = sha256(text);
    const existing = this.state.sources[logicalId];
    const current = existing?.current;
    if (current?.status === "active" && current.hash === hash) {
      return {
        status: "unchanged",
        logicalId,
        revision: current.revision,
        sourceId: current.packetId,
        hash,
        affectedTopicIds: this.#affectedTopics(logicalId),
      };
    }

    const before = await this.#listPacketIds();
    const result = await this.client.callTool(
      "wiki_capture_source",
      { title, text },
      { timeoutMs: this.client.timeoutMs },
    );
    let packetId = parseSourceId(result.text);
    if (!packetId) {
      const after = await this.#listPacketIds();
      const created = [...after].filter((id) => !before.has(id)).sort();
      packetId = created.at(-1) ?? null;
    }
    if (!packetId) {
      throw new Error(`wiki_capture_source did not return a source id: ${result.text.slice(0, 300)}`);
    }

    const rawFile = path.join(this.paths.rawSourcesDir, packetId, "extracted.md");
    if (!(await pathExists(rawFile))) {
      throw new Error(`captured packet is missing ${rawFile}`);
    }
    const extracted = (await readText(rawFile)) ?? text;
    const nextRevision = revision ?? `r${(existing?.history?.length ?? 0) + 1}`;
    const capturedAt = nowIso();

    let replacedPacketId = null;
    if (current?.status === "active" && current.packetId !== packetId) {
      replacedPacketId = current.packetId;
      await this.#markSourcePage(current.packetId, {
        status: "revoked",
        state: "inactive",
        revoked_at: capturedAt,
        revoked_reason: `superseded by ${logicalId}@${nextRevision}`,
        superseded_by: packetId,
      });
      existing.history ??= [];
      existing.history.push({
        revision: current.revision,
        packetId: current.packetId,
        hash: current.hash,
        status: "superseded",
        capturedAt: current.capturedAt,
        supersededAt: capturedAt,
      });
    }

    await this.#writeSourcePage({
      packetId,
      logicalId,
      revision: nextRevision,
      title,
      text: extracted,
      capturedAt,
      metadata,
    });
    await this.rebuildMeta();

    const record = this.state.sources[logicalId] ?? { history: [] };
    record.history ??= [];
    record.status = "active";
    record.current = {
      revision: nextRevision,
      packetId,
      hash,
      status: "active",
      capturedAt,
      title,
      metadata,
    };
    this.state.sources[logicalId] = record;
    await this.#save();

    return {
      status: replacedPacketId ? "replaced" : "captured",
      logicalId,
      revision: nextRevision,
      sourceId: packetId,
      replacedSourceId: replacedPacketId,
      hash,
      affectedTopicIds: this.#affectedTopics(logicalId),
    };
  }

  #affectedTopics(logicalId) {
    return Object.values(this.state.topics)
      .filter((topic) => topic.sourceIds.includes(logicalId))
      .map((topic) => topic.id)
      .sort();
  }

  async #writeSourcePage({ packetId, logicalId, revision, title, text, capturedAt, metadata }) {
    const pagePath = path.join(this.paths.wikiDir, "sources", `${packetId}.md`);
    const firstParagraph = text.split(/\n\s*\n/).map((part) => part.trim()).find(Boolean) ?? "";
    const data = {
      ...metadata,
      type: "source",
      title,
      description: firstParagraph.slice(0, 240),
      status: "published",
      state: "active",
      project_id: this.projectId,
      source_id: packetId,
      source_revision: revision,
      logical_source_id: logicalId,
      captured: capturedAt.slice(0, 10),
      format: "text",
      raw_path: `raw/sources/${packetId}/extracted.md`,
      generated: false,
      verified: true,
    };
    const body = ["## 原文", "", text.trim()].join("\n");
    await ensureDir(path.dirname(pagePath));
    await writeText(pagePath, renderFrontmatter(data, body));
  }

  async #markSourcePage(packetId, changes) {
    const pagePath = path.join(this.paths.wikiDir, "sources", `${packetId}.md`);
    const content = await readText(pagePath);
    if (content === null) return false;
    const parsed = parseFrontmatter(content);
    if (!parsed.ok) return false;
    const data = { ...parsed.data, ...changes, updated: nowIso().slice(0, 10) };
    await writeText(pagePath, renderFrontmatter(data, parsed.body));
    return true;
  }

  async rebuildMeta() {
    const result = await this.client.callTool("wiki_rebuild_meta", {}, { timeoutMs: this.client.timeoutMs });
    return result.text;
  }

  async ingest({ batchSize = 5 } = {}) {
    const result = await this.client.callTool(
      "wiki_ingest",
      { batch_size: Math.max(1, Math.min(5, batchSize)) },
      { timeoutMs: this.client.timeoutMs },
    );
    const manual = /No background LLM available/i.test(result.text);
    const none = /No uningested source packets|All sources ingested/i.test(result.text);
    return {
      mode: manual ? "manual" : none ? "none" : "model",
      text: result.text,
      note: manual
        ? "No model lane configured; this adapter synthesizes deterministically from captured packets instead."
        : none
          ? "All captured packets are already synthesized; call capture_source for new material."
          : "Server-side model synthesis ran; review the server report.",
    };
  }

  async #activeSourcesForTopic(topic) {
    const sources = [];
    for (const logicalId of topic.sourceIds) {
      const record = this.state.sources[logicalId];
      if (!record?.current || record.current.status !== "active") continue;
      const rawFile = path.join(this.paths.rawSourcesDir, record.current.packetId, "extracted.md");
      const text = await readText(rawFile);
      if (text === null) {
        throw new Error(`missing raw packet for ${logicalId}: ${rawFile}`);
      }
      sources.push({
        logicalId,
        packetId: record.current.packetId,
        revision: record.current.revision,
        title: record.current.title ?? logicalId,
        text,
      });
    }
    return sources;
  }

  async compile(topicId) {
    const topic = this.#topic(topicId);
    const sources = await this.#activeSourcesForTopic(topic);
    let draft;
    if (sources.length === 0) {
      draft = revokedDraft({ topic, projectId: this.projectId });
    } else {
      draft = compileTopic({
        topic: {
          id: topic.id,
          title: topic.title,
          thesis: topic.thesis,
          keywords: topic.keywords,
          projectId: this.projectId,
          createdAt: topic.createdAt,
        },
        sources,
      });
    }
    await ensureDir(this.paths.draftsDir);
    await writeText(path.join(this.paths.draftsDir, `${safeId(topicId)}.md`), draft.markdown);
    await writeText(
      path.join(this.paths.draftsDir, `${safeId(topicId)}.json`),
      `${JSON.stringify(
        {
          topicId,
          draftHash: draft.draftHash,
          evidence: draft.evidence,
          sources: draft.sources,
          coverage: draft.coverage,
          warnings: draft.warnings,
        },
        null,
        2,
      )}\n`,
    );
    this.drafts.set(topicId, draft);
    topic.lastDraft = {
      hash: draft.draftHash,
      at: nowIso(),
      evidenceCount: draft.evidenceCount,
      status: draft.status ?? "published",
    };
    await this.#save();
    return {
      topicId,
      title: draft.title,
      status: draft.status ?? "published",
      draftHash: draft.draftHash,
      evidenceCount: draft.evidenceCount,
      coverage: draft.coverage,
      warnings: draft.warnings,
      markdown: draft.markdown,
    };
  }

  async #currentPage(topic) {
    if (!topic.published?.path) return null;
    const relative = topic.published.path.endsWith(".md")
      ? topic.published.path
      : `${topic.published.path}.md`;
    const file = path.join(this.paths.wikiDir, relative);
    return readText(file);
  }

  async planPublish(topicId) {
    const topic = this.#topic(topicId);
    const draft = this.drafts.get(topicId) ?? (await this.compile(topicId));
    const before =
      (await readText(path.join(this.paths.publishedDir, `${safeId(topicId)}.md`))) ??
      (await this.#currentPage(topic)) ??
      "";
    const diff = diffLines(before, draft.markdown);
    return {
      topicId,
      status: "pending_review",
      draftHash: draft.draftHash,
      beforeHash: sha256(before),
      diff: summarizeDiff(diff),
      unifiedDiff: renderUnifiedDiff(diff, {
        beforeLabel: topic.published?.path ?? "published",
        afterLabel: `drafts/${safeId(topicId)}.md`,
      }),
      requiresApproval: true,
    };
  }

  async publish(topicId, { confirm = false } = {}) {
    if (confirm !== true) {
      throw new Error("publish requires explicit confirm:true after reviewing planPublish()");
    }
    const topic = this.#topic(topicId);
    const draft = this.drafts.get(topicId) ?? (await this.compile(topicId));
    const snapshotFile = path.join(this.paths.publishedDir, `${safeId(topicId)}.md`);
    const before = (await readText(snapshotFile)) ?? (await this.#currentPage(topic)) ?? "";
    const pageId = `syntheses/${topic.slug}`;
    const pagePath = path.join(this.paths.wikiDir, "syntheses", `${topic.slug}.md`);
    await ensureDir(path.dirname(pagePath));
    await writeText(pagePath, draft.markdown);
    await this.rebuildMeta();
    await writeText(snapshotFile, draft.markdown);

    topic.published = {
      path: pageId,
      hash: draft.draftHash,
      evidenceCount: draft.evidenceCount,
      at: nowIso(),
      status: draft.status ?? "published",
    };
    topic.status = (draft.status ?? "published") === "revoked" ? "revoked" : "active";
    await this.#save();
    return {
      status: "published",
      topicId,
      pageId,
      path: pagePath,
      hash: draft.draftHash,
      evidenceCount: draft.evidenceCount,
      pageStatus: draft.status ?? "published",
      diff: summarizeDiff(diffLines(before, draft.markdown)),
    };
  }

  async revokeSource(logicalId, { reason = "revoked by operator" } = {}) {
    const record = this.state.sources[logicalId];
    if (!record?.current || record.current.status !== "active") {
      return { status: "already_inactive", logicalId, affectedTopicIds: this.#affectedTopics(logicalId) };
    }
    const revokedAt = nowIso();
    await this.#markSourcePage(record.current.packetId, {
      status: "revoked",
      state: "inactive",
      revoked_at: revokedAt,
      revoked_reason: reason,
    });
    record.history ??= [];
    record.history.push({
      ...record.current,
      status: "revoked",
      revokedAt,
      revokedReason: reason,
    });
    record.current.status = "revoked";
    record.current.revokedAt = revokedAt;
    record.status = "revoked";
    await this.rebuildMeta();
    await this.#save();
    return {
      status: "revoked",
      logicalId,
      sourceId: record.current.packetId,
      affectedTopicIds: this.#affectedTopics(logicalId),
    };
  }

  async recall(query, { maxResults = 5 } = {}) {
    if (!query || String(query).trim() === "") throw new Error("query is required");
    const result = await this.client.callTool(
      "wiki_recall",
      { query, max_results: Math.max(1, Math.min(20, maxResults)) },
      { timeoutMs: this.client.timeoutMs },
    );
    const parsed = parseJsonText(result.text);
    const matches = Array.isArray(parsed) ? parsed : (parsed?.matches ?? []);
    const accepted = [];
    const rejected = { outsideVault: 0, notPublished: 0, notActive: 0, foreignProject: 0, unreadable: 0 };
    for (const match of matches) {
      const rawPath = typeof match?.path === "string" ? match.path : null;
      let matchPath = null;
      if (rawPath) {
        matchPath = path.isAbsolute(rawPath)
          ? path.resolve(rawPath)
          : path.resolve(this.paths.wikiDir, rawPath.replace(/^\.?[\\/]?(?:\.llm-wiki[\\/]wiki[\\/])?/, ""));
      } else if (typeof match?.id === "string") {
        matchPath = path.resolve(this.paths.wikiDir, `${match.id}.md`);
      }
      if (!matchPath || !isWithin(this.paths.wikiDir, matchPath)) {
        rejected.outsideVault += 1;
        continue;
      }
      const content = await readText(matchPath);
      if (content === null) {
        rejected.unreadable += 1;
        continue;
      }
      const parsedPage = parseFrontmatter(content);
      if (!parsedPage.ok) {
        rejected.unreadable += 1;
        continue;
      }
      const meta = parsedPage.data;
      if (meta.status !== "published") {
        rejected.notPublished += 1;
        continue;
      }
      if (meta.state !== "active") {
        rejected.notActive += 1;
        continue;
      }
      if (meta.project_id !== this.projectId) {
        rejected.foreignProject += 1;
        continue;
      }
      accepted.push({
        ...match,
        path: matchPath,
        relativePath: toPosix(path.relative(this.paths.wikiDir, matchPath)),
        kind: meta.type ?? null,
        meta: {
          type: meta.type ?? null,
          title: meta.title ?? match.title ?? null,
          status: meta.status,
          state: meta.state,
          project_id: meta.project_id,
          topic_id: meta.topic_id ?? null,
        },
      });
    }
    return {
      query,
      matches: accepted,
      rejected,
      filteredCount: accepted.length,
      rawCount: matches.length,
    };
  }

  async readPublished(idOrPath) {
    const candidate = path.isAbsolute(idOrPath)
      ? path.resolve(idOrPath)
      : path.resolve(this.paths.wikiDir, String(idOrPath).replace(/^\/+/, ""));
    const withExt = candidate.endsWith(".md") ? candidate : `${candidate}.md`;
    if (!isWithin(this.paths.wikiDir, withExt)) {
      return { ok: false, reason: "outside_vault" };
    }
    const content = await readText(withExt);
    if (content === null) return { ok: false, reason: "not_found" };
    const parsed = parseFrontmatter(content);
    if (!parsed.ok) return { ok: false, reason: "unparsable_page" };
    const meta = parsed.data;
    if (meta.status !== "published") return { ok: false, reason: "not_published" };
    if (meta.state !== "active") return { ok: false, reason: "not_active" };
    if (meta.project_id !== this.projectId) return { ok: false, reason: "foreign_project" };
    return {
      ok: true,
      id: toPosix(path.relative(this.paths.wikiDir, withExt)).replace(/\.md$/, ""),
      path: withExt,
      meta,
      body: parsed.body,
      content,
    };
  }

  async status() {
    const result = await this.client.callTool("wiki_status", {}, { timeoutMs: this.client.timeoutMs });
    return { ok: true, text: result.text, data: parseJsonText(result.text) };
  }

  async lint() {
    const result = await this.client.callTool("wiki_lint", {}, { timeoutMs: this.client.timeoutMs });
    return { ok: true, text: result.text, data: parseJsonText(result.text) };
  }
}

function revokedDraft({ topic, projectId }) {
  const markdown = renderFrontmatter(
    {
      type: "synthesis",
      title: topic.title,
      description: `Topic ${topic.id} revoked`,
      status: "revoked",
      state: "inactive",
      project_id: projectId,
      topic_id: topic.id,
      created: topic.createdAt?.slice(0, 10) ?? nowIso().slice(0, 10),
      updated: nowIso().slice(0, 10),
      generated: true,
      verified: false,
      sources: [],
      evidence: [],
    },
    [`# ${topic.title}`, "", "> 本主题已撤销：没有活跃来源。", "", "## 证据与出处", "", "（无）"].join("\n"),
  );
  return {
    topicId: topic.id,
    title: topic.title,
    markdown,
    body: "",
    status: "revoked",
    evidence: [],
    sources: [],
    coverage: [],
    warnings: [`topic ${topic.id} has no active source`],
    draftHash: sha256(markdown),
    evidenceCount: 0,
  };
}
