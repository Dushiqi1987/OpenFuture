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

test("S1 in-process ACP host: load, real compress, sidecar, restart", { timeout: 180_000 }, () => {
  const run = spawnSync(process.execPath, ["src/s1/acp-probe.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    timeout: 150_000,
  });
  assert.equal(run.status, 0, `S1 command failed\nstdout:\n${run.stdout}\nstderr:\n${run.stderr}`);
  const summary = readRunSummary(run.stdout);
  assert.equal(summary.status, "PASS", run.stdout);

  const report = JSON.parse(readFileSync(summary.report, "utf8"));
  assert.equal(report.status, "PASS");
  const byName = new Map(report.checks.map((check) => [check.name, check]));
  for (const name of [
    "pi_host_detected",
    "no_acp_delegate_tools",
    "context_tools_registered",
    "compress_tool_executed",
    "compressed_block_persisted",
    "compressed_summary_visible",
    "native_compaction_not_owned_by_pi",
    "restart_keeps_adapter_tools",
    "restart_keeps_sidecar",
    "restart_keeps_compressed_summary",
  ]) {
    assert.equal(byName.get(name)?.ok, true, `${name} failed: ${JSON.stringify(report.checks, null, 2)}`);
  }
});
