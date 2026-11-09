import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WikiAdapter } from "../src/adapter.mjs";
import { parseFrontmatter, renderFrontmatter } from "../src/frontmatter.mjs";
import { SOURCES } from "../src/fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, "fixtures", "stub-wiki-server.mjs");

async function openAdapter(t, projectId = "review-safety") {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "openfuture-wiki-review-"));
  const adapter = await WikiAdapter.open({
    baseDir,
    projectId,
    topic: "Review safety",
    serverPath: STUB,
  });
  t.after(async () => {
    await adapter.close();
    await rm(baseDir, { recursive: true, force: true });
  });
  return adapter;
}

test("review plans are bound to the reviewed page and cannot be replayed", { timeout: 120_000 }, async (t) => {
  const adapter = await openAdapter(t);
  adapter.defineTopic({
    id: "topic-plan",
    title: "计划绑定",
    keywords: ["来源", "主题"],
    sourceIds: ["src-arch"],
  });
  const source = SOURCES["src-arch"];
  await adapter.captureSource({
    logicalId: "src-arch",
    title: source.title,
    text: source.text,
    revision: "r1",
  });
  await adapter.compile("topic-plan");
  const firstPlan = await adapter.planPublish("topic-plan");
  const published = await adapter.publish("topic-plan", {
    confirm: true,
    planId: firstPlan.planId,
  });
  await assert.rejects(
    () => adapter.publish("topic-plan", { confirm: true, planId: firstPlan.planId }),
    (error) => error.code === "REVIEW_PLAN_REQUIRED",
  );

  const pagePath = path.join(adapter.paths.wikiDir, `${published.pageId}.md`);
  const plan = await adapter.planPublish("topic-plan");
  await writeFile(pagePath, `${await readFile(pagePath, "utf8")}\n<!-- drift after review -->\n`, "utf8");
  await assert.rejects(
    () => adapter.publish("topic-plan", { confirm: true, planId: plan.planId }),
    (error) => error.code === "STALE_REVIEW_PLAN",
  );

  const freshPlan = await adapter.planPublish("topic-plan");
  const republished = await adapter.publish("topic-plan", {
    confirm: true,
    planId: freshPlan.planId,
  });
  assert.equal(republished.status, "published");
  assert.equal((await adapter.readPublished(published.pageId)).ok, true);
});

test("revoked and replaced sources hide topic pages and reject forged metadata", { timeout: 120_000 }, async (t) => {
  const adapter = await openAdapter(t, "review-evidence");
  adapter.defineTopic({
    id: "topic-evidence",
    title: "证据绑定主题",
    keywords: ["来源", "主题", "vault"],
    sourceIds: ["src-arch", "src-wiki"],
  });
  for (const logicalId of ["src-arch", "src-wiki"]) {
    const source = SOURCES[logicalId];
    await adapter.captureSource({
      logicalId,
      title: source.title,
      text: source.text,
      revision: "r1",
    });
  }
  await adapter.compile("topic-evidence");
  const plan = await adapter.planPublish("topic-evidence");
  const published = await adapter.publish("topic-evidence", {
    confirm: true,
    planId: plan.planId,
  });
  const pagePath = path.join(adapter.paths.wikiDir, `${published.pageId}.md`);

  await adapter.revokeSource("src-wiki");
  const hidden = await adapter.readPublished(published.pageId);
  assert.equal(hidden.ok, false);
  assert.equal(hidden.reason, "not_published");

  // A forged page that still claims published/active must fail evidence binding.
  const parsed = parseFrontmatter(await readFile(pagePath, "utf8"));
  assert.equal(parsed.ok, true);
  await writeFile(
    pagePath,
    renderFrontmatter({ ...parsed.data, status: "published", state: "active" }, parsed.body),
    "utf8",
  );
  const forged = await adapter.readPublished(published.pageId);
  assert.equal(forged.ok, false);
  assert.equal(forged.reason, "stale_evidence");

  const recalled = await adapter.recall("证据绑定主题", { maxResults: 10 });
  assert.ok(!recalled.matches.some((match) => match.relativePath === `${published.pageId}.md`));
  assert.ok(recalled.rejected.staleEvidence >= 1);

  const replacement = {
    ...SOURCES["src-arch"],
    text: `${SOURCES["src-arch"].text}\n\n替换来源后新增的回归段落，用于确认旧计划与旧证据都被隐藏。`,
  };
  await adapter.captureSource({
    logicalId: "src-arch",
    title: replacement.title,
    text: replacement.text,
    revision: "r2",
  });
  const afterReplace = await adapter.readPublished(published.pageId);
  assert.equal(afterReplace.ok, false);
  assert.equal(afterReplace.reason, "not_published");
});

test("junctions under the wiki root cannot escape physical containment", { timeout: 120_000 }, async (t) => {
  const adapter = await openAdapter(t, "review-junction");
  const outsideDir = await mkdtemp(path.join(os.tmpdir(), "openfuture-wiki-outside-"));
  const link = path.join(adapter.paths.wikiDir, "linked");
  t.after(async () => {
    await rm(link, { recursive: true, force: true });
    await rm(outsideDir, { recursive: true, force: true });
  });
  const marker = "JUNCTION_SECRET_MARKER_7c2e";
  await writeFile(
    path.join(outsideDir, "secret.md"),
    renderFrontmatter(
      {
        type: "synthesis",
        title: "Junction secret",
        status: "published",
        state: "active",
        project_id: "review-junction",
      },
      `# Secret\n\n${marker}`,
    ),
    "utf8",
  );
  await symlink(outsideDir, link, "junction");

  const read = await adapter.readPublished("linked/secret");
  assert.equal(read.ok, false);
  assert.equal(read.reason, "outside_vault");

  const recalled = await adapter.recall(marker, { maxResults: 5 });
  assert.equal(recalled.matches.length, 0);
  assert.ok(!JSON.stringify(recalled.matches).includes(marker));
  if (recalled.rawCount > 0) assert.ok(recalled.rejected.outsideVault >= 1);

  adapter.defineTopic({
    id: "topic-preview",
    title: "本地预览主题",
    keywords: ["来源"],
    sourceIds: ["src-arch"],
  });
  const source = SOURCES["src-arch"];
  await adapter.captureSource({
    logicalId: "src-arch",
    title: source.title,
    text: source.text,
    revision: "r1",
  });
  await adapter.compile("topic-preview");
  const plan = await adapter.planPublish("topic-preview");
  const published = await adapter.publish("topic-preview", { confirm: true, planId: plan.planId });
  const local = await adapter.recall("本地预览主题", { maxResults: 5 });
  const hit = local.matches.find((match) => match.relativePath === `${published.pageId}.md`);
  assert.ok(hit);
  assert.ok(!hit.preview.includes("SERVER_PREVIEW_SENTINEL"));
  assert.ok(hit.preview.length > 0);
});

test("same-title topics keep distinct, stable page ids", { timeout: 120_000 }, async (t) => {
  const adapter = await openAdapter(t, "review-slug");
  const source = SOURCES["src-arch"];
  await adapter.captureSource({
    logicalId: "src-arch",
    title: source.title,
    text: source.text,
    revision: "r1",
  });
  adapter.defineTopic({
    id: "topic-one",
    title: "同名主题",
    keywords: ["来源"],
    sourceIds: ["src-arch"],
  });
  adapter.defineTopic({
    id: "topic-two",
    title: "同名主题",
    keywords: ["来源"],
    sourceIds: ["src-arch"],
  });
  await adapter.compile("topic-one");
  const onePlan = await adapter.planPublish("topic-one");
  const one = await adapter.publish("topic-one", { confirm: true, planId: onePlan.planId });
  await adapter.compile("topic-two");
  const twoPlan = await adapter.planPublish("topic-two");
  const two = await adapter.publish("topic-two", { confirm: true, planId: twoPlan.planId });

  assert.notEqual(one.pageId, two.pageId);
  assert.equal(await readFile(path.join(adapter.paths.wikiDir, `${one.pageId}.md`), "utf8").then(Boolean), true);
  assert.equal(await readFile(path.join(adapter.paths.wikiDir, `${two.pageId}.md`), "utf8").then(Boolean), true);
  assert.equal((await adapter.readPublished(one.pageId)).meta.topic_id, "topic-one");
  assert.equal((await adapter.readPublished(two.pageId)).meta.topic_id, "topic-two");

  adapter.defineTopic({
    id: "topic-two",
    title: "同名主题",
    keywords: ["来源"],
    sourceIds: ["src-arch"],
  });
  assert.equal(adapter.state.topics["topic-two"].pageId, two.pageId);
});
