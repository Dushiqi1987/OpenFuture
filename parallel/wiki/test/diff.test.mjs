import test from "node:test";
import assert from "node:assert/strict";
import { diffLines, renderUnifiedDiff, summarizeDiff } from "../src/diff.mjs";

test("detects added and removed lines", () => {
  const diff = diffLines("alpha\nbeta\ngamma", "alpha\nBETA\ngamma");
  assert.equal(diff.changed, true);
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  assert.equal(diff.hunks.length, 1);
  const rendered = renderUnifiedDiff(diff, { beforeLabel: "published", afterLabel: "draft" });
  assert.match(rendered, /^--- published/m);
  assert.match(rendered, /^\+\+\+ draft/m);
  assert.match(rendered, /^-beta$/m);
  assert.match(rendered, /^\+BETA$/m);
});

test("identical input has no diff", () => {
  const diff = diffLines("one\ntwo", "one\ntwo");
  assert.equal(diff.changed, false);
  assert.equal(diff.added, 0);
  assert.equal(diff.removed, 0);
  const summary = summarizeDiff(diff);
  assert.equal(summary.changed, false);
  assert.equal(summary.added, 0);
  assert.equal(summary.removed, 0);
});

test("first publication is all additions", () => {
  const diff = diffLines("", "# 标题\n\n第一段");
  assert.equal(diff.changed, true);
  assert.equal(diff.removed, 0);
  assert.ok(diff.added >= 2);
});
