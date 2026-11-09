#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runAcceptance } from "./acceptance.mjs";
import { WikiAdapter } from "./adapter.mjs";
import { pathExists } from "./util.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_DELIVERY = path.resolve(HERE, "..");
const DEFAULT_STUB = path.join(REPO_DELIVERY, "test", "fixtures", "stub-wiki-server.mjs");

function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value.startsWith("--")) {
      const [key, inline] = value.slice(2).split("=");
      if (inline !== undefined) args[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith("--")) args[key] = argv[++i];
      else args[key] = true;
    } else {
      args._.push(value);
    }
  }
  return args;
}

async function selfCheck(args) {
  const serverPath = args.server ?? process.env.PI_LLM_WIKI_SERVER ?? DEFAULT_STUB;
  const checks = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      checks.push({ name, ok: true, detail });
    } catch (error) {
      checks.push({ name, ok: false, detail: error.message });
    }
  };
  await check("node runtime >= 22", () => {
    const major = Number(process.versions.node.split(".")[0]);
    if (major < 22) throw new Error(`Node ${process.versions.node} is below 22`);
    return process.versions.node;
  });
  await check("MCP server path exists", async () => {
    if (!(await pathExists(serverPath))) throw new Error(`not found: ${serverPath}`);
    return serverPath;
  });
  await check("adapter boots an isolated vault and closes cleanly", async () => {
    const adapter = await WikiAdapter.open({
      baseDir: args.base ?? path.join(process.env.TEMP ?? process.env.TMP ?? ".", "openfuture-wiki-selfcheck"),
      projectId: "selfcheck",
      topic: "Self check",
      serverPath,
    });
    try {
      const status = await adapter.status();
      if (!status.ok) throw new Error("status failed");
      return { bootstrapped: adapter.bootstrapped, server: adapter.client.serverInfo };
    } finally {
      await adapter.close();
    }
  });
  for (const item of checks) {
    console.log(`${item.ok ? "PASS" : "FAIL"}  ${item.name}${item.detail ? ` — ${JSON.stringify(item.detail)}` : ""}`);
  }
  return checks.every((item) => item.ok);
}

async function main() {
  const [command = "help"] = process.argv.slice(2);
  const args = parseArgs(process.argv.slice(2));
  if (command === "help" || command === "--help" || command === "-h") {
    console.log(
      [
        "Usage: node src/cli.mjs <command> [options]",
        "",
        "Commands:",
        "  self-check   Verify runtime, server path, isolated bootstrap and shutdown.",
        "  accept       Run the independent acceptance suite (stub by default).",
        "",
        "Options:",
        "  --server <path>   MCP server entry (default: test/fixtures/stub-wiki-server.mjs",
        "                    or PI_LLM_WIKI_SERVER).",
        "  --base <dir>      Base directory for temporary project vaults.",
        "  --out <dir>       Acceptance report directory (default: parallel/wiki/acceptance).",
        "  --keep            Keep the temporary vaults for inspection.",
        "",
        "Ports 19732/19742 are reserved for this workspace; the adapter is stdio-only",
        "and opens no listening socket.",
      ].join("\n"),
    );
    return true;
  }
  if (command === "self-check") return selfCheck(args);
  if (command === "accept") {
    const report = await runAcceptance({
      baseDir: args.base,
      serverPath: args.server ?? process.env.PI_LLM_WIKI_SERVER ?? DEFAULT_STUB,
      keep: args.keep === true,
      outDir: args.out ?? path.join(REPO_DELIVERY, "acceptance"),
    });
    console.log(
      `${report.ok ? "PASS" : "FAIL"}  acceptance: ${report.summary.passed}/${report.summary.total} checks (${report.mode})`,
    );
    for (const check of report.checks.filter((item) => !item.ok)) {
      console.log(`  FAIL ${check.name}: ${check.detail}`);
    }
    if (report.fatal) console.log(`  FATAL ${report.fatal.split("\n")[0]}`);
    return report.ok;
  }
  console.error(`Unknown command: ${command}`);
  return false;
}

main()
  .then((ok) => {
    process.exitCode = ok ? 0 : 1;
  })
  .catch((error) => {
    console.error(error.stack ?? error.message);
    process.exitCode = 1;
  });
