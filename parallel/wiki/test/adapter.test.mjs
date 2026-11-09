import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WikiAdapter } from "../src/adapter.mjs";
import { SOURCES } from "../src/fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, "fixtures", "stub-wiki-server.mjs");

test("capture, compile, publish, recall and revoke form a closed loop", { timeout: 120_000 }, async (t) => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "openfuture-wiki-adapter-"));
  const adapter = await WikiAdapter.open({
    baseDir,
    projectId: "test-alpha",
    topic: "Adapter test",
    serverPath: STUB,
  });
  t.after(async () => {
    await adapter.close();
    await rm(baseDir, { recursive: true, force: true });
  });

  adapter.defineTopic({
    id: "topic-a",
    title: "并行交付架构",
    keywords: ["架构", "分支", "提交", "适配器"],
    sourceIds: ["src-arch"],
  });
  const source = SOURCES["src-arch"];
  const captured = await adapter.captureSource({
    logicalId: "src-arch",
    title: source.title,
    text: source.text,
    revision: "r1",
  });
  assert.equal(captured.status, "captured");
  assert.match(captured.sourceId, /^SRC-\d{4}-\d{2}-\d{2}-\d{3}$/);

  const unchanged = await adapter.captureSource({
    logicalId: "src-arch",
    title: source.title,
    text: source.text,
    revision: "r1",
  });
  assert.equal(unchanged.status, "unchanged");

  const draft = await adapter.compile("topic-a");
  assert.ok(draft.evidenceCount >= 2);
  const plan = await adapter.planPublish("topic-a");
  assert.equal(plan.status, "pending_review");
  assert.equal(plan.diff.changed, true);
  assert.ok(plan.diff.added > 0);

  const published = await adapter.publish("topic-a", { confirm: true });
  assert.equal(published.status, "published");
  const read = await adapter.readPublished(published.pageId);
  assert.equal(read.ok, true);
  assert.equal(read.meta.project_id, "test-alpha");
  assert.equal(read.meta.status, "published");

  const recalled = await adapter.recall("适配器", { maxResults: 5 });
  assert.ok(recalled.matches.some((match) => match.relativePath === `${published.pageId}.md`));
  assert.ok(recalled.matches.every((match) => match.meta.project_id === "test-alpha"));

  const revoked = await adapter.revokeSource("src-arch");
  assert.equal(revoked.status, "revoked");
  assert.deepEqual(revoked.affectedTopicIds, ["topic-a"]);
  const revokedDraft = await adapter.compile("topic-a");
  assert.equal(revokedDraft.status, "revoked");
  await adapter.publish("topic-a", { confirm: true });
  const readAfter = await adapter.readPublished(published.pageId);
  assert.equal(readAfter.ok, false);
  assert.equal(readAfter.reason, "not_published");
});
