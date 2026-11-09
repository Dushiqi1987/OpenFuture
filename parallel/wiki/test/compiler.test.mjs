import test from "node:test";
import assert from "node:assert/strict";
import { compileTopic, splitParagraphs } from "../src/compiler.mjs";
import { parseFrontmatter } from "../src/frontmatter.mjs";
import { SOURCES, TOPICS } from "../src/fixtures.mjs";

test("splitParagraphs keeps exact character offsets", () => {
  const text = "第一段内容。\n\n第二段内容。\n\n第三段内容。";
  const paragraphs = splitParagraphs(text);
  assert.equal(paragraphs.length, 3);
  for (const paragraph of paragraphs) {
    assert.equal(text.slice(paragraph.start, paragraph.end), paragraph.text);
    assert.equal(paragraph.end - paragraph.start, paragraph.text.length);
  }
});

test("compileTopic emits per-paragraph citations and canonical sources", () => {
  const topic = TOPICS[0];
  const sources = ["src-arch", "src-workflow"].map((logicalId, index) => ({
    logicalId,
    packetId: `SRC-2026-01-02-00${index + 1}`,
    revision: "r1",
    title: SOURCES[logicalId].title,
    text: SOURCES[logicalId].text,
  }));
  const draft = compileTopic({
    topic: { ...topic, projectId: "proj-alpha" },
    sources,
    now: "2026-01-02T00:00:00.000Z",
  });
  assert.ok(draft.evidenceCount >= 4);
  assert.equal(draft.evidence.length, draft.evidenceCount);
  const parsed = parseFrontmatter(draft.markdown);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.data.type, "synthesis");
  assert.equal(parsed.data.status, "published");
  assert.equal(parsed.data.project_id, "proj-alpha");
  assert.equal(parsed.data.sources.length, 2);
  assert.equal(parsed.data.evidence.length, draft.evidenceCount);
  for (const item of parsed.data.evidence) {
    assert.equal(item.locator.type, "char_range");
    assert.ok(Number.isInteger(item.locator.start));
    assert.ok(item.locator.end >= item.locator.start);
    assert.ok(item.quote.length > 0);
  }
  const reviewSection = parsed.body.split("## 主题综述\n\n")[1].split("\n\n## 证据与出处")[0];
  const paragraphs = reviewSection.split("\n\n").filter(Boolean);
  assert.ok(paragraphs.length >= 3);
  for (const paragraph of paragraphs) {
    assert.match(paragraph, /\[\d+\]$/);
  }
  assert.equal(JSON.parse(JSON.stringify(draft.evidence)).length, draft.evidenceCount);
});
