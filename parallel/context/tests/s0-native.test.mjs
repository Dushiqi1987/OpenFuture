import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));

function readRunSummary(stdout) {
  const text = stdout.trim();
  assert.ok(text, `script printed no summary:\n${stdout}`);
  return JSON.parse(text);
}

test("S0 native baseline: compaction, retention, restart, isolation", { timeout: 180_000 }, () => {
  const run = spawnSync(process.execPath, ["src/s0/native-baseline.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 150_000,
  });
  assert.equal(run.status, 0, `S0 command failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  const summary = readRunSummary(run.stdout);
  assert.equal(summary.summaryStatus ?? summary.status, "PASS", run.stdout);

  const report = JSON.parse(readFileSync(summary.report, "utf8"));
  assert.equal(report.status, "PASS");
  assert.ok(report.checks.length >= 8);
  assert.ok(report.checks.every((check) => check.ok), JSON.stringify(report.checks, null, 2));

  const byName = new Map(report.checks.map((check) => [check.name, check]));
  assert.ok(byName.get("auto_compaction_triggered").detail >= 1);
  assert.ok(byName.get("repeated_compaction_triggered").detail >= 2);
  assert.equal(byName.get("original_history_remains_readable").ok, true);
  assert.equal(byName.get("restart_preserves_entries").ok, true);
  assert.equal(byName.get("new_session_is_isolated").ok, true);
});
