import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WikiAdapter } from "./adapter.mjs";
import { StdioMcpClient } from "./mcp-client.mjs";
import { createServerEnv } from "./vault.mjs";
import { parseFrontmatter, renderFrontmatter } from "./frontmatter.mjs";
import { FOREIGN_MARKER, REPLACEMENTS, SOURCES, TOPICS } from "./fixtures.mjs";
import { ensureDir, nowIso, pathExists, sha256, writeText } from "./util.mjs";

const DEFAULT_STUB = fileURLToPath(new URL("../test/fixtures/stub-wiki-server.mjs", import.meta.url));

async function seedPersonalVault({ serverPath, nodePath, paths, writePage }) {
  const env = { ...createServerEnv(paths), WIKI_ROOT: paths.homeRoot };
  const client = new StdioMcpClient({
    serverPath,
    nodePath,
    cwd: paths.homeRoot,
    env,
    timeoutMs: 60_000,
  });
  await client.start();
  try {
    await client.callTool("wiki_bootstrap", { topic: "Foreign personal vault", mode: "personal" });
    await writePage();
    await client.callTool("wiki_rebuild_meta", {});
  } finally {
    await client.close();
  }
}

function countSectionParagraphs(body) {
  const lines = body.split("\n");
  const start = lines.findIndex((line) => line.trim() === "## 主题综述");
  const end = lines.findIndex((line) => line.trim() === "## 证据与出处");
  if (start === -1 || end === -1 || end <= start) return [];
  return lines
    .slice(start + 1, end)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function markerNumbers(text) {
  return [...text.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]));
}

export async function runAcceptance({
  baseDir,
  serverPath = process.env.PI_LLM_WIKI_SERVER || DEFAULT_STUB,
  nodePath = process.execPath,
  keep = false,
  projectId = "proj-alpha",
  outDir = null,
} = {}) {
  const startedAt = nowIso();
  const workRoot = baseDir ?? (await mkdtemp(path.join(os.tmpdir(), "openfuture-wiki-accept-")));
  const checks = [];
  const artifacts = {};
  const adapters = [];
  const expect = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail: detail ?? null });
      return detail;
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
      return undefined;
    }
  };

  let fatal = null;
  try {
    const adapter = await WikiAdapter.open({
      baseDir: workRoot,
      projectId,
      topic: "Alpha 合成知识库",
      serverPath,
      nodePath,
    });
    adapters.push(adapter);
    artifacts.projectRoot = adapter.paths.projectRoot;
    artifacts.vaultRoot = adapter.paths.vaultRoot;
    artifacts.serverInfo = adapter.client.serverInfo;
    artifacts.bootstrapped = adapter.bootstrapped;

    await expect("bootstrap creates .llm-wiki/config.json", async () => {
      assert.equal(adapter.bootstrapped, true);
      assert.equal(await pathExists(adapter.paths.configFile), true);
      return adapter.paths.configFile;
    });
    await expect("server identifies as pi-llm-wiki over stdio", async () => {
      assert.equal(adapter.client.serverInfo?.name, "llm-wiki");
      assert.match(adapter.client.stderr, /LLM Wiki MCP Server running on stdio/);
      return adapter.client.serverInfo.version;
    });

    for (const topic of TOPICS) adapter.defineTopic(topic);

    const captured = {};
    for (const logicalId of ["src-arch", "src-workflow", "src-wiki"]) {
      const source = SOURCES[logicalId];
      const result = await adapter.captureSource({
        logicalId,
        title: source.title,
        text: source.text,
        revision: "r1",
      });
      captured[logicalId] = result;
      await expect(`capture ${logicalId} -> published source page`, async () => {
        assert.equal(result.status, "captured");
        assert.match(result.sourceId, /^SRC-\d{4}-\d{2}-\d{2}-\d{3}$/);
        const raw = path.join(adapter.paths.rawSourcesDir, result.sourceId, "extracted.md");
        assert.equal(await pathExists(raw), true);
        const page = await readFile(path.join(adapter.paths.wikiDir, "sources", `${result.sourceId}.md`), "utf8");
        const parsed = parseFrontmatter(page);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.data.status, "published");
        assert.equal(parsed.data.state, "active");
        assert.equal(parsed.data.project_id, projectId);
        return { sourceId: result.sourceId, affectedTopicIds: result.affectedTopicIds };
      });
    }
    artifacts.sourceIds = Object.fromEntries(
      Object.entries(captured).map(([key, value]) => [key, value.sourceId]),
    );

    await expect("capture routes changes only to topics that list the source", async () => {
      assert.deepEqual(captured["src-arch"].affectedTopicIds, ["topic-runtime"]);
      assert.deepEqual(captured["src-workflow"].affectedTopicIds, ["topic-runtime"]);
      assert.deepEqual(captured["src-wiki"].affectedTopicIds, ["topic-wiki"]);
    });

    await expect("ingest reports that captured packets are already synthesized", async () => {
      const result = await adapter.ingest({ batchSize: 3 });
      assert.equal(result.mode, "none");
      assert.ok(result.text.length > 0);
      return { mode: result.mode, firstLine: result.text.split("\n")[0] };
    });

    await expect("lint runs against the real vault layout", async () => {
      const result = await adapter.lint();
      assert.match(result.text, /pages:\s*3/i);
      return result.text.split("\n")[0];
    });

    const draftA = await adapter.compile("topic-runtime");
    await expect("compile produces per-paragraph citations", async () => {
      assert.equal(draftA.status, "published");
      assert.ok(draftA.evidenceCount >= 4);
      const parsedDraft = parseFrontmatter(draftA.markdown);
      assert.equal(parsedDraft.ok, true);
      const paragraphs = countSectionParagraphs(parsedDraft.body);
      assert.ok(paragraphs.length >= 3);
      for (const paragraph of paragraphs) {
        assert.match(paragraph, /\[\d+\]$/, `paragraph lacks a citation: ${paragraph.slice(0, 80)}`);
      }
      return { paragraphs: paragraphs.length, evidenceCount: draftA.evidenceCount };
    });
    await expect("evidence DTO is JSON-serializable and fully locatable", async () => {
      const parsed = parseFrontmatter(draftA.markdown);
      assert.equal(parsed.ok, true);
      const evidence = parsed.data.evidence;
      assert.ok(Array.isArray(evidence) && evidence.length === draftA.evidenceCount);
      for (const item of evidence) {
        assert.ok(item.evidenceId);
        assert.equal(item.projectId, projectId);
        assert.match(item.sourceId, /^SRC-/);
        assert.equal(item.sourceRevision, "r1");
        assert.equal(item.locator.type, "char_range");
        assert.ok(Number.isInteger(item.locator.start));
        assert.ok(item.locator.end >= item.locator.start);
      }
      assert.equal(JSON.parse(JSON.stringify(evidence)).length, evidence.length);
      return evidence[0];
    });

    const planA = await adapter.planPublish("topic-runtime");
    await expect("first publish shows an all-added diff and waits for review", async () => {
      assert.equal(planA.status, "pending_review");
      assert.equal(planA.diff.changed, true);
      assert.ok(planA.diff.added > 0);
      assert.match(planA.unifiedDiff, /^--- published/m);
      return { added: planA.diff.added, removed: planA.diff.removed };
    });
    const publishedA = await adapter.publish("topic-runtime", { confirm: true });
    artifacts.pageA = publishedA.pageId;
    await expect("publish writes a readable, published topic page", async () => {
      assert.equal(publishedA.status, "published");
      const read = await adapter.readPublished(publishedA.pageId);
      assert.equal(read.ok, true);
      assert.equal(read.meta.project_id, projectId);
      assert.equal(read.meta.status, "published");
      return { pageId: publishedA.pageId, hash: publishedA.hash };
    });

    const draftB = await adapter.compile("topic-wiki");
    const publishedB = await adapter.publish("topic-wiki", { confirm: true });
    artifacts.pageB = publishedB.pageId;
    const pageBPath = path.join(adapter.paths.wikiDir, `${publishedB.pageId}.md`);
    const hashBBefore = sha256(await readFile(pageBPath, "utf8"));
    await expect("recall returns published project pages with previews", async () => {
      const result = await adapter.recall("并行 工作区", { maxResults: 5 });
      assert.ok(result.matches.length >= 1);
      assert.ok(result.matches.every((match) => match.meta.project_id === projectId));
      assert.ok(result.matches.some((match) => match.relativePath === `${publishedA.pageId}.md`));
      return result.matches.map((match) => match.relativePath);
    });

    const opsCapture = await adapter.captureSource({
      logicalId: "src-ops",
      title: SOURCES["src-ops"].title,
      text: SOURCES["src-ops"].text,
      revision: "r1",
    });
    await adapter.addSourceToTopic("topic-runtime", "src-ops");
    const draftA2 = await adapter.compile("topic-runtime");
    const planA2 = await adapter.planPublish("topic-runtime");
    const publishedA2 = await adapter.publish("topic-runtime", { confirm: true });
    await expect("adding one source updates only its topic", async () => {
      assert.deepEqual(opsCapture.affectedTopicIds, []);
      assert.notEqual(draftA2.draftHash, draftA.draftHash);
      assert.equal(planA2.diff.changed, true);
      assert.equal(publishedA2.hash, draftA2.draftHash);
      assert.equal(sha256(await readFile(pageBPath, "utf8")), hashBBefore);
      return { added: planA2.diff.added, removed: planA2.diff.removed };
    });

    const replacement = REPLACEMENTS["src-workflow"];
    const replaced = await adapter.captureSource({
      logicalId: "src-workflow",
      title: replacement.title,
      text: replacement.text,
      revision: replacement.revision,
    });
    await expect("replacing a source revokes the old packet and reports the affected topic", async () => {
      assert.equal(replaced.status, "replaced");
      assert.equal(replaced.revision, "r2");
      assert.deepEqual(replaced.affectedTopicIds, ["topic-runtime"]);
      const oldPage = await readFile(
        path.join(adapter.paths.wikiDir, "sources", `${replaced.replacedSourceId}.md`),
        "utf8",
      );
      const parsed = parseFrontmatter(oldPage);
      assert.equal(parsed.data.status, "revoked");
      assert.equal(parsed.data.state, "inactive");
      return { oldPacket: replaced.replacedSourceId, newPacket: replaced.sourceId };
    });
    const draftA3 = await adapter.compile("topic-runtime");
    const planA3 = await adapter.planPublish("topic-runtime");
    await adapter.publish("topic-runtime", { confirm: true });
    await expect("replacement recompiles the topic against revision r2 only", async () => {
      const parsed = parseFrontmatter(draftA3.markdown);
      assert.ok(parsed.data.sources.some((source) => source.revision === "r2"));
      assert.ok(!parsed.data.sources.some((source) => source.id.endsWith(replaced.replacedSourceId)));
      assert.equal(planA3.diff.changed, true);
      const readOld = await adapter.readPublished(`sources/${replaced.replacedSourceId}`);
      assert.equal(readOld.ok, false);
      assert.equal(readOld.reason, "not_published");
      assert.equal(sha256(await readFile(pageBPath, "utf8")), hashBBefore);
      return { added: planA3.diff.added, removed: planA3.diff.removed };
    });

    const pageAPath = path.join(adapter.paths.wikiDir, `${publishedA2.pageId}.md`);
    const hashABeforeRevoke = sha256(await readFile(pageAPath, "utf8"));
    const revoked = await adapter.revokeSource("src-wiki", { reason: "acceptance revoke" });
    const draftB2 = await adapter.compile("topic-wiki");
    const planB2 = await adapter.planPublish("topic-wiki");
    await adapter.publish("topic-wiki", { confirm: true });
    await expect("revoking the only source revokes its topic and removes it from recall", async () => {
      assert.equal(revoked.status, "revoked");
      assert.deepEqual(revoked.affectedTopicIds, ["topic-wiki"]);
      assert.equal(draftB2.status, "revoked");
      assert.equal(planB2.diff.changed, true);
      const readB = await adapter.readPublished(publishedB.pageId);
      assert.equal(readB.ok, false);
      assert.equal(readB.reason, "not_published");
      const recalled = await adapter.recall("ingest", { maxResults: 10 });
      assert.equal(recalled.matches.length, 0);
      assert.ok(recalled.rejected.notPublished >= 1 || recalled.rejected.notActive >= 1);
      return { rejected: recalled.rejected, added: planB2.diff.added, removed: planB2.diff.removed };
    });
    await expect("unaffected topic page is byte-identical after other-topic revoke", async () => {
      assert.notEqual(sha256(await readFile(pageBPath, "utf8")), hashBBefore);
      assert.equal(sha256(await readFile(pageAPath, "utf8")), hashABeforeRevoke);
      return "topic-runtime page untouched; topic-wiki page revoked";
    });

    const foreignDir = path.join(adapter.paths.homeRoot, ".llm-wiki", "wiki", "syntheses");
    await seedPersonalVault({
      serverPath,
      nodePath,
      paths: adapter.paths,
      writePage: async () => {
        await ensureDir(foreignDir);
        await writeFile(
          path.join(foreignDir, "foreign.md"),
          renderFrontmatter(
            {
              type: "synthesis",
              title: "Foreign vault page",
              status: "published",
              state: "active",
              project_id: "proj-beta",
            },
            `# Foreign\n\n${FOREIGN_MARKER} 这段内容不属于本项目。`,
          ),
          "utf8",
        );
      },
    });
    await expect("recall rejects pages outside the project vault without leaking content", async () => {
      const result = await adapter.recall(FOREIGN_MARKER, { maxResults: 5 });
      assert.equal(result.matches.length, 0);
      assert.ok(result.rejected.outsideVault >= 1);
      assert.ok(!JSON.stringify(result).includes("这段内容不属于本项目"));
      return result.rejected;
    });
    await expect("readPublished refuses paths outside the vault", async () => {
      const read = await adapter.readPublished(path.join(foreignDir, "foreign.md"));
      assert.equal(read.ok, false);
      assert.equal(read.reason, "outside_vault");
      return read.reason;
    });

    const beta = await WikiAdapter.open({
      baseDir: workRoot,
      projectId: "proj-beta",
      topic: "Beta 合成知识库",
      serverPath,
      nodePath,
    });
    adapters.push(beta);
    await beta.defineTopic({
      id: "topic-beta",
      title: "Beta 主题",
      thesis: "Beta 的独立 vault。",
      keywords: ["beta"],
      sourceIds: ["src-beta"],
    });
    await beta.captureSource({
      logicalId: "src-beta",
      title: "Beta 合成资料",
      text: "BETA_ONLY_MARKER_7a1 只存在于 Beta 项目的临时 vault。",
      revision: "r1",
    });
    await beta.compile("topic-beta");
    await beta.publish("topic-beta", { confirm: true });
    await expect("separate projects do not leak into each other's recall", async () => {
      const fromAlpha = await adapter.recall("BETA_ONLY_MARKER_7a1", { maxResults: 5 });
      const fromBeta = await beta.recall("BETA_ONLY_MARKER_7a1", { maxResults: 5 });
      assert.equal(fromAlpha.matches.length, 0);
      assert.ok(fromBeta.matches.length >= 1);
      return { alphaMatches: fromAlpha.matches.length, betaMatches: fromBeta.matches.length };
    });

    artifacts.diffSample = planA2.unifiedDiff.split("\n").slice(0, 12);
    artifacts.finalRecall = (await adapter.recall("测试端口", { maxResults: 5 })).matches.map(
      (match) => match.relativePath,
    );
  } catch (error) {
    fatal = error.stack ?? error.message;
  } finally {
    for (const adapter of adapters) {
      try {
        await adapter.close();
      } catch {
        // Best-effort shutdown; the process is short-lived either way.
      }
    }
    if (!keep) {
      try {
        await rm(workRoot, { recursive: true, force: true });
      } catch {
        // Windows can keep handles briefly; the OS temp cleaner handles the rest.
      }
    }
  }

  const report = {
    ok: fatal === null && checks.every((check) => check.ok),
    mode: serverPath === DEFAULT_STUB ? "stub" : "real",
    serverPath,
    startedAt,
    finishedAt: nowIso(),
    workRoot: keep ? workRoot : null,
    fatal,
    summary: {
      passed: checks.filter((check) => check.ok).length,
      failed: checks.filter((check) => !check.ok).length,
      total: checks.length,
    },
    checks,
    artifacts,
  };
  if (outDir) {
    await ensureDir(outDir);
    await writeText(path.join(outDir, "latest.json"), `${JSON.stringify(report, null, 2)}\n`);
    await writeText(path.join(outDir, "latest.md"), renderReport(report));
  }
  return report;
}

export function renderReport(report) {
  const lines = [
    "# Wiki 适配器独立验收报告",
    "",
    `- 结果：**${report.ok ? "通过" : "失败"}**`,
    `- 模式：${report.mode}`,
    `- 服务端：\`${report.serverPath}\``,
    `- 时间：${report.startedAt} → ${report.finishedAt}`,
    `- 检查：${report.summary.passed}/${report.summary.total} 通过`,
    "",
    "| # | 检查 | 结果 | 证据 |",
    "|---|------|------|------|",
    ...report.checks.map((check, index) => {
      const detail =
        check.detail && typeof check.detail === "object"
          ? JSON.stringify(check.detail)
          : String(check.detail ?? "");
      return `| ${index + 1} | ${check.name} | ${check.ok ? "PASS" : "FAIL"} | ${detail
        .replace(/\|/g, "\\|")
        .replace(/\n/g, " ")
        .slice(0, 300)} |`;
    }),
    "",
  ];
  if (report.fatal) lines.push("## Fatal", "", "```", report.fatal, "```", "");
  if (report.artifacts?.diffSample) {
    lines.push("## Diff 样例", "", "```diff", ...report.artifacts.diffSample, "```", "");
  }
  return `${lines.join("\n")}\n`;
}
