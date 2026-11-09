import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

const DEPS = existsSync(new URL("../node_modules/acp-kernel/package.json", import.meta.url));
const skip = DEPS ? false : "acp-kernel is not installed; run pnpm install in parallel/context first";

let KernelHost;
let RevocationSet;
let projectPiMessages;
let sidecarPath;
if (!skip) {
  ({ KernelHost } = await import("../src/runtime/kernel-host.mjs"));
  ({ RevocationSet } = await import("../src/runtime/revocation.mjs"));
  ({ projectPiMessages } = await import("../src/runtime/projection.mjs"));
  ({ sidecarPath } = await import("../src/runtime/state-store.mjs"));
}

function user(text, id) {
  return { role: "user", content: text, evidenceId: id };
}

function assistantTool(evidenceId, callId, label) {
  return {
    role: "assistant",
    evidenceId,
    content: [
      { type: "text", text: "calling probe" },
      { type: "toolCall", id: callId, name: "mock_probe", arguments: { label } },
    ],
  };
}

function toolResult(callId, text, evidenceId) {
  return {
    role: "toolResult",
    evidenceId,
    toolCallId: callId,
    toolName: "mock_probe",
    content: [{ type: "text", text }],
    isError: false,
  };
}

function long(text) {
  return `${text} ${"synthetic-context-filler ".repeat(120)}`;
}

function freshStore() {
  return mkdtempSync(join(tmpdir(), "of-context-"));
}

test("projection keeps a valid tool call/result pair", { skip }, () => {
  const pi = [
    user("PROJECT_PATH=D:\\OpenFuture-parallel\\context", "u1"),
    assistantTool("a1", "call-1", "ok"),
    toolResult("call-1", "TOOL_RESULT_OK", "tr1"),
    user("NEXT_TASK_SENTINEL=continue", "u2"),
  ];
  const core = projectPiMessages(pi, { revocations: new RevocationSet() });
  const call = core.find((message) => message.contentType === "tool-call");
  const result = core.find((message) => message.contentType === "tool-result");
  assert.equal(call?.toolCallId, "call-1");
  assert.equal(result?.toolCallId, "call-1");
  assert.equal(result?.text, "TOOL_RESULT_OK");
});

test("revocation before projection removes both halves of a tool pair", { skip }, () => {
  const pi = [
    user("keep", "u1"),
    assistantTool("a1", "call-1", "ok"),
    toolResult("call-1", "SECRET_TOOL_RESULT", "tr1"),
    user("after", "u2"),
  ];
  const revocations = new RevocationSet({ ids: ["ev:tr1"], texts: ["SECRET_TOOL_RESULT"] });
  const core = projectPiMessages(pi, { revocations });
  assert.equal(core.some((message) => message.contentType === "tool-call"), false);
  assert.equal(core.some((message) => message.contentType === "tool-result"), false);
  assert.equal(core.some((message) => message.text.includes("SECRET_TOOL_RESULT")), false);
});

test("host compresses, persists, restarts, and keeps blocks isolated", { skip }, async () => {
  const storeRoot = freshStore();
  try {
    const host = KernelHost.open({
      projectId: "project-A",
      sessionId: "session-A",
      storeRoot,
      modelContextLimit: 1200,
      timeoutMs: 2000,
    });
    assert.equal(host.mode, "acp");

    const pi = [
      user(long("PROJECT_PATH=D:\\OpenFuture-parallel\\context"), "u1"),
      assistantTool("a1", "call-1", "ok"),
      toolResult("call-1", "TOOL_RESULT_OK", "tr1"),
      user(long("NEXT_TASK_SENTINEL=write acceptance note"), "u2"),
      user(long("tail question"), "u3"),
    ];

    const first = await host.process(pi);
    assert.equal(first.mode, "acp");
    assert.ok(first.messages.length > 0);
    assert.ok(host.lastProjectedMessages().length >= 4);

    const again = await host.process(pi);
    assert.equal(again.duplicateSuppressed, true);

    const refs = host.lastProjectedMessages().map((message) => host.refFor(message.id));
    assert.ok(refs.every(Boolean), `missing refs: ${JSON.stringify(refs)}`);
    const compressed = host.applyCompression({
      ranges: [
        {
          startRef: refs[0],
          endRef: refs[4],
          summary: "GOAL: continue. NEXT_TASK_SENTINEL=write acceptance note. TOOL_RESULT_OK.",
          topic: "baseline",
        },
      ],
    });
    assert.equal(compressed.ok, true, JSON.stringify(compressed));
    assert.ok(compressed.blocksCreated >= 1);
    assert.ok(host.listBlocks().length >= 1);

    const afterCompression = await host.process(pi);
    assert.equal(afterCompression.mode, "acp");
    assert.equal(host.listBlocks().length, compressed.blocksCreated);

    const reopened = KernelHost.open({
      projectId: "project-A",
      sessionId: "session-A",
      storeRoot,
      modelContextLimit: 1200,
    });
    assert.equal(reopened.mode, "acp");
    assert.equal(reopened.listBlocks().length, host.listBlocks().length);
    assert.equal(reopened.revision, host.revision);

    const otherSession = KernelHost.open({
      projectId: "project-B",
      sessionId: "session-B",
      storeRoot,
      modelContextLimit: 1200,
    });
    assert.equal(otherSession.listBlocks().length, 0);
    assert.equal(otherSession.revision, 0);
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("revocation invalidates the block and never re-emits its sentinel", { skip }, async () => {
  const storeRoot = freshStore();
  try {
    const host = KernelHost.open({
      projectId: "project-A",
      sessionId: "session-revoke",
      storeRoot,
      modelContextLimit: 1200,
    });
    const secret = "REVOKED_SENTINEL=project-A-private-budget-4711";
    const pi = [
      user(long(`early context ${secret}`), "u1"),
      assistantTool("a1", "call-1", "ok"),
      toolResult("call-1", "SECRET_TOOL_RESULT", "tr1"),
      user(long("NEXT_TASK_SENTINEL=continue"), "u2"),
      user(long("tail"), "u3"),
    ];
    await host.process(pi);
    const refs = host.lastProjectedMessages().map((message) => host.refFor(message.id));
    const compressed = host.applyCompression({
      ranges: [
        {
          startRef: refs[0],
          endRef: refs[4],
          summary: `checkpoint ${secret} SECRET_TOOL_RESULT`,
          topic: "revoked",
        },
      ],
    });
    assert.equal(compressed.ok, true, JSON.stringify(compressed));
    assert.ok(host.listBlocks().length >= 1);

    const revoked = host.revoke(["ev:u1"], [secret, "SECRET_TOOL_RESULT"]);
    assert.equal(revoked.ok, true);
    assert.ok(revoked.invalidatedBlocks.length >= 1);

    const out = await host.process(pi);
    const serialized = JSON.stringify(out.messages);
    assert.equal(serialized.includes(secret), false);
    assert.equal(serialized.includes("SECRET_TOOL_RESULT"), false);

    const blockId = host.listBlocks()[0].blockId;
    const decompressed = host.decompress(blockId);
    assert.equal(decompressed.ok, false);
    assert.equal(decompressed.code, "REVOKED_BLOCK");

    const reopened = KernelHost.open({
      projectId: "project-A",
      sessionId: "session-revoke",
      storeRoot,
      modelContextLimit: 1200,
    });
    assert.ok(reopened.status(0).invalidatedBlocks.includes(blockId));
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("a corrupt sidecar falls back to native without throwing", { skip }, () => {
  const storeRoot = freshStore();
  try {
    const file = sidecarPath(storeRoot, "project-A", "session-corrupt");
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "{not-json", "utf8");
    const host = KernelHost.open({
      projectId: "project-A",
      sessionId: "session-corrupt",
      storeRoot,
      modelContextLimit: 1200,
    });
    assert.equal(host.mode, "native");
    assert.match(host.fallbackReason, /SIDECAR/);
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("a failed sidecar write switches the host to native", { skip }, async () => {
  const storeRoot = freshStore();
  try {
    const host = KernelHost.open({
      projectId: "project-A",
      sessionId: "session-write-fail",
      storeRoot,
      modelContextLimit: 1200,
    });
    host.sidecarFile = join(storeRoot, "missing-parent", "\u0000bad");
    const pi = [user(long("hello"), "u1")];
    const out = await host.process(pi);
    assert.equal(out.mode, "native");
    assert.equal(host.mode, "native");
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }
});

test("kernel failure falls back to the original Pi messages", { skip }, async () => {
  const storeRoot = freshStore();
  try {
    const host = KernelHost.open({
      projectId: "project-A",
      sessionId: "session-fail",
      storeRoot,
      modelContextLimit: 1200,
    });
    host.core = {
      processTurn() {
        throw new Error("MOCK_KERNEL_FAILURE");
      },
    };
    const pi = [user(long("hello"), "u1")];
    const out = await host.process(pi);
    assert.equal(out.mode, "native");
    assert.equal(out.messages, pi);
    assert.match(out.fallbackReason, /MOCK_KERNEL_FAILURE/);
  } finally {
    rmSync(storeRoot, { recursive: true, force: true });
  }
});
