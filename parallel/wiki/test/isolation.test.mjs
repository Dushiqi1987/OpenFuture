import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { WikiAdapter } from "../src/adapter.mjs";
import { renderFrontmatter } from "../src/frontmatter.mjs";
import { ensureDir } from "../src/util.mjs";
import { FOREIGN_MARKER, SOURCES } from "../src/fixtures.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const STUB = path.join(HERE, "fixtures", "stub-wiki-server.mjs");

test("projects are isolated and foreign personal pages never leak content", { timeout: 120_000 }, async (t) => {
  const baseDir = await mkdtemp(path.join(os.tmpdir(), "openfuture-wiki-isolation-"));
  const alpha = await WikiAdapter.open({
    baseDir,
    projectId: "proj-alpha",
    topic: "Alpha",
    serverPath: STUB,
  });
  const beta = await WikiAdapter.open({
    baseDir,
    projectId: "proj-beta",
    topic: "Beta",
    serverPath: STUB,
  });
  t.after(async () => {
    await alpha.close();
    await beta.close();
    await rm(baseDir, { recursive: true, force: true });
  });

  alpha.defineTopic({ id: "topic-alpha", title: "Alpha 主题", keywords: ["架构"], sourceIds: ["src-arch"] });
  await alpha.captureSource({
    logicalId: "src-arch",
    title: SOURCES["src-arch"].title,
    text: SOURCES["src-arch"].text,
    revision: "r1",
  });
  await alpha.compile("topic-alpha");
  const alphaPlan = await alpha.planPublish("topic-alpha");
  const alphaPage = await alpha.publish("topic-alpha", { confirm: true, planId: alphaPlan.planId });

  const foreignDir = path.join(alpha.paths.homeRoot, ".llm-wiki", "wiki", "syntheses");
  await ensureDir(foreignDir);
  const foreignBody = `这段内容不属于本项目 ${FOREIGN_MARKER}`;
  await writeFile(
    path.join(foreignDir, "foreign.md"),
    renderFrontmatter(
      {
        type: "synthesis",
        title: "Foreign page",
        status: "published",
        state: "active",
        project_id: "proj-beta",
      },
      foreignBody,
    ),
    "utf8",
  );

  const alphaRecall = await alpha.recall(FOREIGN_MARKER, { maxResults: 5 });
  assert.equal(alphaRecall.matches.length, 0);
  assert.ok(alphaRecall.rejected.outsideVault >= 1);
  assert.ok(!JSON.stringify(alphaRecall).includes(foreignBody));

  const readForeign = await alpha.readPublished(path.join(foreignDir, "foreign.md"));
  assert.equal(readForeign.ok, false);
  assert.equal(readForeign.reason, "outside_vault");

  beta.defineTopic({ id: "topic-beta", title: "Beta 主题", keywords: ["项目", "资料"], sourceIds: ["src-beta"] });
  await beta.captureSource({
    logicalId: "src-beta",
    title: "Beta 合成资料",
    text: `Beta 项目独有资料。\n\n${FOREIGN_MARKER} 只应出现在 Beta 项目。`,
    revision: "r1",
  });
  await beta.compile("topic-beta");
  const betaPlan = await beta.planPublish("topic-beta");
  const betaPage = await beta.publish("topic-beta", { confirm: true, planId: betaPlan.planId });

  const alphaAgain = await alpha.recall(FOREIGN_MARKER, { maxResults: 5 });
  assert.equal(alphaAgain.matches.length, 0);
  const betaRecall = await beta.recall(FOREIGN_MARKER, { maxResults: 5 });
  assert.ok(betaRecall.matches.some((match) => match.relativePath === `${betaPage.pageId}.md`));

  const crossRead = await alpha.readPublished(path.join(beta.paths.wikiDir, `${betaPage.pageId}.md`));
  assert.equal(crossRead.ok, false);
  assert.equal(crossRead.reason, "outside_vault");

  const alphaRead = await alpha.readPublished(alphaPage.pageId);
  assert.equal(alphaRead.ok, true);
});
