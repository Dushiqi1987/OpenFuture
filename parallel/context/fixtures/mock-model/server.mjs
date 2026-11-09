import { createServer } from "node:http";
import { mkdirSync, appendFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_CAPTURE = resolve(HERE, "../../.scratch/captures/mock-requests.jsonl");
const SUMMARY_SYSTEM_MARKER = "context summarization assistant";

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("\n");
}

function userRefs(messages) {
  const refs = [];
  for (const message of messages ?? []) {
    if (message.role !== "user") continue;
    const text = textOf(message.content);
    for (const match of text.matchAll(/<acp[^>]*>(m\d+)<\/acp>/g)) refs.push(match[1]);
  }
  return [...new Set(refs)];
}

function messagesText(messages) {
  return (messages ?? [])
    .map((m) => `${m.role ?? ""}\n${textOf(m.content)}\n${m.tool_calls ? JSON.stringify(m.tool_calls) : ""}`)
    .join("\n");
}

function isSummaryRequest(body) {
  const system = (body.messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => textOf(m.content))
    .join("\n");
  const all = messagesText(body.messages);
  return system.toLowerCase().includes(SUMMARY_SYSTEM_MARKER) || all.includes("<conversation>");
}

function extractSummaryMarkers(body) {
  const all = messagesText(body.messages);
  const markers = [
    "PROJECT_PATH=",
    "MODEL_ID=",
    "API_CONTRACT=",
    "FAILURE_CODE=",
    "NEXT_TASK_SENTINEL=",
    "REVOKED_SENTINEL=",
    "SESSION_A_SENTINEL=",
    "SESSION_B_SENTINEL=",
  ];
  const found = [];
  for (const marker of markers) {
    const index = all.indexOf(marker);
    if (index >= 0) {
      const end = all.indexOf("\n", index);
      found.push(all.slice(index, end < 0 ? Math.min(all.length, index + 240) : end).trim());
    }
  }
  const sentinels = [...new Set(all.match(/S0-SUMMARY-SENTINEL-\d+/g) ?? [])];
  return { found: [...new Set(found)], sentinels };
}

function summaryText(body, summaryCount) {
  const { found, sentinels } = extractSummaryMarkers(body);
  const lines = found.length > 0 ? found.map((item) => `- ${item}`) : ["- (none)"];
  const previous = sentinels.length > 0 ? `\n- Previous checkpoints: ${sentinels.join(", ")}` : "";
  return `## Goal
Exercise Pi 1.5.0 native compaction and the local OpenFuture host adapter.

## Constraints & Preferences
- Local mock model only; no external model endpoint.
- Keep exact identifiers and the unfinished acceptance task.

## Progress
### Done
- [x] Synthetic turns and tool result were sent.
- [x] Compaction summary was requested from the local mock.

### In Progress
- [ ] Verify restart, retention, and repeated compaction.

### Blocked
- (none)

## Key Decisions
- **Static summary in mock**: deterministic checkpoint content for assertions.

## Next Steps
1. Reopen the session and continue the unfinished task.
2. Compare native and in-process host behavior.

## Critical Context
${lines.join("\n")}
- S0-SUMMARY-SENTINEL-${summaryCount}${previous}`;
}

function usageFor(body, completionChars) {
  const promptTokens = Math.max(1, Math.ceil(messagesText(body.messages).length / 4));
  const completionTokens = Math.max(1, Math.ceil(completionChars / 4));
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
  };
}

function writeSse(res, payload) {
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function streamText(res, model, text, usage) {
  const id = `chatcmpl-mock-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }],
  });
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
    usage,
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function streamToolCall(res, model, name, args, usage) {
  const id = `chatcmpl-mock-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const callId = `call_mock_${Date.now()}`;
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
  });
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: {
          role: "assistant",
          tool_calls: [
            { index: 0, id: callId, type: "function", function: { name, arguments: "" } },
          ],
        },
        finish_reason: null,
      },
    ],
  });
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(args) } }] },
        finish_reason: null,
      },
    ],
  });
  writeSse(res, {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
    usage,
  });
  res.write("data: [DONE]\n\n");
  res.end();
}

function jsonCompletion(res, model, text, usage) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      id: `chatcmpl-mock-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        { index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" },
      ],
      usage,
    }),
  );
}

function toolJsonCompletion(res, model, name, args, usage) {
  res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
  res.end(
    JSON.stringify({
      id: `chatcmpl-mock-${Date.now()}`,
      object: "chat.completion",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [
        {
          index: 0,
          message: {
            role: "assistant",
            content: null,
            tool_calls: [
              {
                id: `call_mock_${Date.now()}`,
                type: "function",
                function: { name, arguments: JSON.stringify(args) },
              },
            ],
          },
          finish_reason: "tool_calls",
        },
      ],
      usage,
    }),
  );
}

export function createMockHandler({ capturePath = DEFAULT_CAPTURE, state = { summaryCount: 0 } } = {}) {
  mkdirSync(dirname(capturePath), { recursive: true });
  return async function handler(req, res) {
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, requests: state.summaryCount }));
      return;
    }
    if (req.method !== "POST" || !req.url?.endsWith("/chat/completions")) {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "not found" } }));
      return;
    }

    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 8 * 1024 * 1024) {
        res.writeHead(413).end();
        return;
      }
    }

    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "invalid json" } }));
      return;
    }

    const model = typeof body.model === "string" ? body.model : "synthetic";
    const summary = isSummaryRequest(body);
    if (summary) state.summaryCount += 1;

    const record = {
      at: new Date().toISOString(),
      model,
      summary,
      summaryCount: state.summaryCount,
      stream: body.stream !== false,
      messageCount: body.messages?.length ?? 0,
      estimatedPromptTokens: Math.max(1, Math.ceil(messagesText(body.messages).length / 4)),
      messages: body.messages ?? [],
      tools: (body.tools ?? []).map((tool) => tool?.function?.name).filter(Boolean),
    };
    appendFileSync(capturePath, `${JSON.stringify(record)}\n`, "utf8");

    if (summary && process.env.MOCK_SUMMARY_429 === "1") {
      res.writeHead(429, { "content-type": "application/json", "retry-after": "1" });
      res.end(
        JSON.stringify({
          error: { message: "mock summary rate limit", type: "rate_limit_error", code: "mock_429" },
        }),
      );
      return;
    }

    if (summary) {
      const text = summaryText(body, state.summaryCount);
      const usage = usageFor(body, text.length);
      if (body.stream === false) jsonCompletion(res, model, text, usage);
      else streamText(res, model, text, usage);
      return;
    }

    const messages = body.messages ?? [];
    const assistantToolCalls = messages.filter(
      (m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0,
    ).length;
    const toolNames = (body.tools ?? []).map((tool) => tool?.function?.name);
    const modelIsS0 = String(model).includes("s0");
    const modelIsS1 = String(model).includes("s1");
    const usedCompress = messages.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some((call) => call?.function?.name === "compress"),
    );
    const usedDecompress = messages.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some((call) => call?.function?.name === "decompress"),
    );
    const usedSearch = messages.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some((call) => call?.function?.name === "search_context"),
    );
    const refs = userRefs(messages);

    if (
      modelIsS1 &&
      toolNames.includes("decompress") &&
      usedCompress &&
      !usedDecompress
    ) {
      const args = { blockId: "b1", full: true };
      const usage = usageFor(body, JSON.stringify(args).length);
      if (body.stream === false) toolJsonCompletion(res, model, "decompress", args, usage);
      else streamToolCall(res, model, "decompress", args, usage);
      return;
    }

    if (
      modelIsS1 &&
      toolNames.includes("search_context") &&
      usedDecompress &&
      !usedSearch
    ) {
      const args = { query: "S1-COMPRESSED-SENTINEL" };
      const usage = usageFor(body, JSON.stringify(args).length);
      if (body.stream === false) toolJsonCompletion(res, model, "search_context", args, usage);
      else streamToolCall(res, model, "search_context", args, usage);
      return;
    }

    if (
      modelIsS1 &&
      toolNames.includes("compress") &&
      !usedCompress &&
      refs.length >= 4
    ) {
      const args = {
        topic: "s1-synthetic-checkpoint",
        content: [
          {
            startId: refs[0],
            endId: refs[refs.length - 2],
            summary:
              "S1-COMPRESSED-SENTINEL: synthetic checkpoint for the in-process adapter test. " +
              "PROJECT_PATH=D:\\\\OpenFuture-parallel\\\\context; NEXT_TASK_SENTINEL=continue the same task after the context manager runs.",
          },
        ],
      };
      const usage = usageFor(body, JSON.stringify(args).length);
      if (body.stream === false) toolJsonCompletion(res, model, "compress", args, usage);
      else streamToolCall(res, model, "compress", args, usage);
      return;
    }

    const usedSecondCompress = messages.some(
      (m) =>
        m.role === "assistant" &&
        Array.isArray(m.tool_calls) &&
        m.tool_calls.some(
          (call) =>
            call?.function?.name === "compress" &&
            String(call.function.arguments ?? "").includes("s1-second-checkpoint"),
        ),
    );

    if (
      modelIsS1 &&
      toolNames.includes("compress") &&
      usedSearch &&
      !usedSecondCompress &&
      refs.length >= 6
    ) {
      const args = {
        topic: "s1-second-checkpoint",
        content: [
          {
            startId: refs[2],
            endId: refs[refs.length - 2],
            summary:
              "S1-SECOND-COMPRESSED-SENTINEL: second in-process checkpoint. " +
              "NEXT_TASK_SENTINEL=continue the same task after repeated compression.",
          },
        ],
      };
      const usage = usageFor(body, JSON.stringify(args).length);
      if (body.stream === false) toolJsonCompletion(res, model, "compress", args, usage);
      else streamToolCall(res, model, "compress", args, usage);
      return;
    }

    if (
      modelIsS0 &&
      toolNames.includes("mock_probe") &&
      assistantToolCalls === 0 &&
      messages.filter((m) => m.role === "user").length >= 2
    ) {
      const args = { label: "fail-once" };
      const usage = usageFor(body, JSON.stringify(args).length);
      if (body.stream === false) toolJsonCompletion(res, model, "mock_probe", args, usage);
      else streamToolCall(res, model, "mock_probe", args, usage);
      return;
    }

    const userCount = messages.filter((m) => m.role === "user").length;
    const last = messages[messages.length - 1];
    const text =
      last?.role === "tool"
        ? `TOOL_RESULT_OBSERVED turn=${userCount}. The failed tool result is part of synthetic history.`
        : `ACK turn=${userCount} model=${model}. Synthetic local response only.`;
    const usage = usageFor(body, text.length);
    if (body.stream === false) jsonCompletion(res, model, text, usage);
    else streamText(res, model, text, usage);
  };
}

export async function startMockServer({ port = 19745, host = "127.0.0.1", capturePath = DEFAULT_CAPTURE } = {}) {
  const state = { summaryCount: 0 };
  const server = createServer(createMockHandler({ capturePath, state }));
  await new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolveListen);
  });
  return {
    server,
    state,
    capturePath,
    url: `http://${host}:${port}/v1`,
    async close() {
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const argPort = process.argv.indexOf("--port");
  const port = argPort >= 0 ? Number(process.argv[argPort + 1]) : 19745;
  const captureArg = process.argv.indexOf("--capture");
  const capturePath = captureArg >= 0 ? process.argv[captureArg + 1] : DEFAULT_CAPTURE;
  const started = await startMockServer({ port, capturePath });
  console.log(`[mock] listening ${started.url} capture=${started.capturePath}`);
  const stop = () => started.close().then(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}
