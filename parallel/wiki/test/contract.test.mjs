import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { StdioMcpClient, parseJsonText } from "../src/mcp-client.mjs";

const SERVER = process.env.PI_LLM_WIKI_SERVER;

test(
  "real pi-llm-wiki 0.12.5 stdio contract",
  { skip: SERVER ? false : "set PI_LLM_WIKI_SERVER to the real dist/mcp/index.js", timeout: 180_000 },
  async () => {
    const base = await mkdtemp(path.join(os.tmpdir(), "openfuture-wiki-real-"));
    const vault = path.join(base, "vault");
    const home = path.join(base, "home");
    await mkdir(vault, { recursive: true });
    await mkdir(home, { recursive: true });
    const client = new StdioMcpClient({
      serverPath: SERVER,
      cwd: vault,
      env: {
        WIKI_ROOT: vault,
        WIKI_HOME: home,
        HOME: home,
        USERPROFILE: home,
        APPDATA: path.join(home, "AppData", "Roaming"),
        LOCALAPPDATA: path.join(home, "AppData", "Local"),
        XDG_CONFIG_HOME: path.join(home, ".config"),
        NO_COLOR: "1",
        CI: "1",
      },
      timeoutMs: 60_000,
    });
    try {
      await client.start();
      const tools = await client.listTools();
      const names = tools.map((tool) => tool.name);
      for (const expected of [
        "wiki_bootstrap",
        "wiki_capture_source",
        "wiki_ingest",
        "wiki_lint",
        "wiki_recall",
        "wiki_status",
        "wiki_rebuild_meta",
      ]) {
        assert.ok(names.includes(expected), `missing tool ${expected}`);
      }

      const boot = await client.callTool("wiki_bootstrap", { topic: "Contract", mode: "personal" });
      assert.ok(boot.text.length > 0);

      const capture = await client.callTool("wiki_capture_source", {
        title: "合成资料",
        text: "第一段合成资料，说明并行工作区边界。\n\n第二段合成资料，说明逐段引用和验收。",
      });
      assert.match(capture.text, /Source captured: SRC-\d{4}-\d{2}-\d{2}-\d{3}/);

      const status = parseJsonText((await client.callTool("wiki_status", {})).text);
      assert.equal(status.totalPages >= 1, true);

      const ingest = await client.callTool("wiki_ingest", { batch_size: 1 });
      assert.ok(ingest.text.length > 0);

      const lint = await client.callTool("wiki_lint", {});
      assert.match(lint.text, /pages:/i);

      const recall = await client.callTool("wiki_recall", { query: "合成资料", max_results: 5 });
      const parsed = parseJsonText(recall.text);
      const matches = Array.isArray(parsed) ? parsed : parsed.matches;
      assert.ok(Array.isArray(matches));
      assert.ok(matches.length >= 1);
      assert.ok(matches[0].path);
    } finally {
      await client.close();
      await rm(base, { recursive: true, force: true });
    }
  },
);
