import test from "node:test";
import assert from "node:assert/strict";
import { parseFrontmatter, renderFrontmatter } from "../src/frontmatter.mjs";

test("round-trips nested evidence and canonical sources", () => {
  const data = {
    type: "synthesis",
    title: "测试主题",
    status: "published",
    state: "active",
    project_id: "proj-alpha",
    generated: true,
    verified: false,
    sources: [
      { id: "sources/SRC-2026-01-02-001", revision: "r1", evidence_ids: ["EV-topic-src-0"] },
    ],
    evidence: [
      {
        evidenceId: "EV-topic-src-0",
        sourceId: "SRC-2026-01-02-001",
        locator: { type: "char_range", start: 0, end: 12 },
        quote: "第一段引用",
      },
    ],
  };
  const body = "第一段 [1]\n\n第二段 [2]";
  const rendered = renderFrontmatter(data, body);
  assert.match(rendered, /^---\n/);
  const parsed = parseFrontmatter(rendered);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.deepEqual(parsed.data, data);
  assert.equal(parsed.body, body);
});

test("rejects unterminated frontmatter", () => {
  const parsed = parseFrontmatter("---\ntype: synthesis\nbody without close");
  assert.equal(parsed.ok, false);
});

test("quotes numeric-looking and boolean-looking strings", () => {
  const rendered = renderFrontmatter({ type: "synthesis", title: "123", status: "true" }, "正文");
  const parsed = parseFrontmatter(rendered);
  assert.equal(parsed.ok, true, parsed.reason);
  assert.equal(parsed.data.title, "123");
  assert.equal(parsed.data.status, "true");
});
