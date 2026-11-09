import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockServer } from "../../fixtures/mock-model/server.mjs";
import { s1Turns } from "../../fixtures/synthetic.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = join(ROOT, ".scratch", "s1", RUN_ID);
const AGENT_DIR = join(RUN_DIR, "agent");
const PROJECT_DIR = join(RUN_DIR, "project");
const SESSION_DIR = join(RUN_DIR, "sessions");
const REPORT_DIR = join(ROOT, "reports");
const MOCK_PORT = Number(process.env.S1_MOCK_PORT ?? 19735);
const TURNS = s1Turns("A");

function ensureDirs() {
  for (const dir of [RUN_DIR, AGENT_DIR, PROJECT_DIR, SESSION_DIR, REPORT_DIR, join(ROOT, ".scratch", "captures")]) {
    mkdirSync(dir, { recursive: true });
  }
}

function writeIsolatedModelConfig() {
  const models = {
    providers: {
      "openfuture-mock": {
        baseUrl: `http://127.0.0.1:${MOCK_PORT}/v1`,
        api: "openai-completions",
        apiKey: "local-test-key",
        authHeader: true,
        models: [
          {
            id: "synthetic-s1",
            name: "Synthetic S1",
            reasoning: false,
            input: ["text"],
            contextWindow: 1600,
            maxTokens: 512,
          },
        ],
      },
    },
  };
  writeFileSync(join(AGENT_DIR, "models.json"), `${JSON.stringify(models, null, 2)}\n`, "utf8");
  writeFileSync(join(AGENT_DIR, "auth.json"), "{}\n", "utf8");
}

function readCapturedRequests(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return undefined;
      }
    })
    .filter(Boolean);
}

function toolNamesOf(request) {
  return (request?.tools ?? [])
    .map((tool) => (typeof tool === "string" ? tool : tool?.function?.name))
    .filter(Boolean);
}

function messagesText(request) {
  return (request?.messages ?? [])
    .map((message) => {
      if (typeof message.content === "string") return message.content;
      if (!Array.isArray(message.content)) return "";
      return message.content.map((part) => (part?.type === "text" ? part.text : "")).join("\n");
    })
    .join("\n");
}

async function main() {
  ensureDirs();
  writeIsolatedModelConfig();

  let pi;
  let acpFactory;
  try {
    pi = await import("@earendil-works/pi-coding-agent");
    ({ createAcpExtension: acpFactory } = await import("billion-context-pi"));
  } catch (error) {
    console.error(
      [
        "S1_NOT_RUN: Pi or billion-context-pi is not importable.",
        `cause: ${error.code ?? error.message}`,
        "run: cd parallel/context && pnpm install --ignore-scripts",
        "then: pnpm run s1:acp",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  const capturePath = join(ROOT, ".scratch", "captures", `s1-${RUN_ID}.jsonl`);
  delete process.env.BILLION_CONTEXT_PROXY;
  delete process.env.BILLION_CONTEXT_NATIVE;
  process.env.ACP_LOG_FILE = join(RUN_DIR, "acp.log");
  const mock = await startMockServer({ port: MOCK_PORT, host: "127.0.0.1", capturePath });

  const report = {
    status: "RUNNING",
    runId: RUN_ID,
    startedAt: new Date().toISOString(),
    ports: { mock: MOCK_PORT },
    paths: { runDir: RUN_DIR, sessionDir: SESSION_DIR, capturePath },
    adapter: {
      package: "billion-context-pi@0.1.83",
      entry: "createAcpExtension",
      delegate: false,
      autoUpdate: false,
      hostSession: false,
    },
    events: [],
    checks: [],
    errors: [],
    observations: {},
  };

  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(AGENT_DIR, "auth.json"),
    modelsPath: join(AGENT_DIR, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModel("openfuture-mock", "synthetic-s1");
  if (!model) throw new Error("S1 model openfuture-mock/synthetic-s1 was not loaded");

  const settingsManager = pi.SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 500 },
  });

  const acp = acpFactory({
    enabled: true,
    delegate: false,
    autoUpdate: false,
    debug: true,
    modelContextLimit: 1600,
    hostSession: false,
    preserveRecentMessages: 1,
    compress: { maxContextLimit: 0.75, emergencyThresholdPercent: 0.95, nudgeGrowthTokens: 1000 },
    coreOverrides: { preserveRecentTokens: 0, compress: { minCompressRange: 500 } },
  });

  function makeLoader() {
    return new pi.DefaultResourceLoader({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      settingsManager,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      extensionFactories: [acp],
    });
  }

  let session;
  let unsubscribe = () => {};
  try {
    const sessionManager = pi.SessionManager.create(PROJECT_DIR, SESSION_DIR);
    const loader = makeLoader();
    await loader.reload();
    const created = await pi.createAgentSession({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      modelRuntime,
      model,
      sessionManager,
      settingsManager,
      resourceLoader: loader,
      tools: ["compress", "decompress", "search_context", "acp_status", "acp_cache"],
    });
    session = created.session;
    const desiredTools = ["compress", "decompress", "search_context", "acp_status", "acp_cache"];
    session.setActiveToolsByName(desiredTools);
    const extensionSummary = {
      keys: created.extensionsResult ? Object.keys(created.extensionsResult) : [],
      errors: created.extensionsResult?.errors ?? [],
      extensionCount: created.extensionsResult?.extensions?.length,
      registeredTools: (created.extensionsResult?.runtime?.getTools?.() ?? []).map((tool) => tool.name),
      allTools: session.getAllTools().map((tool) => tool.name),
      activeTools: session.getActiveToolNames(),
    };
    report.extensionSummary = extensionSummary;
    unsubscribe = session.subscribe((event) => {
      if (event?.type === "compaction_start" || event?.type === "compaction_end") {
        report.events.push({ type: event.type, reason: event.reason, aborted: event.aborted });
      }
    });

    for (const turn of TURNS) {
      await session.prompt(turn);
      await session.waitForIdle?.();
    }

    const requests = readCapturedRequests(capturePath);
    const normalRequests = requests.filter((request) => !request.summary);
    const last = normalRequests.at(-1);
    const tools = [...new Set(normalRequests.flatMap(toolNamesOf))].sort();
    const text = messagesText(last);
    const conversationText = messagesText({
      messages: normalRequests.flatMap((request) => request.messages ?? []).filter((message) => message.role !== "system"),
    });
    const sidecar = `${session.sessionFile}.acp.json`;
    const sidecarExists = existsSync(sidecar);
    let sidecarJson;
    if (sidecarExists) {
      try {
        sidecarJson = JSON.parse(readFileSync(sidecar, "utf8"));
      } catch {
        sidecarJson = undefined;
      }
    }

    const sidecarRefs = Array.isArray(sidecarJson?.blocks)
      ? sidecarJson.blocks.flatMap((block) => [block.startRef, block.endRef]).filter(Boolean)
      : [];
    const acpRefSamples = [...new Set([...sidecarRefs, ...(conversationText.match(/<acp[^>]*>|m[0-9]{5,}/g) ?? [])])].slice(0, 12);
    const countToolCalls = (name) =>
      session.messages.filter(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some((part) => part?.type === "toolCall" && part.name === name),
      ).length;
    const toolResultText = (name) =>
      session.messages
        .filter((message) => message.role === "toolResult" && message.toolName === name)
        .map((message) =>
          (message.content ?? [])
            .map((part) => (part?.type === "text" ? part.text : ""))
            .join("\n"),
        )
        .join("\n");

    report.observations = {
      requestCount: requests.length,
      lastToolNames: toolNamesOf(last),
      allToolNames: tools,
      lastMessageCount: last?.messages?.length ?? 0,
      containsAcpRef: conversationText.includes("<acp") || sidecarRefs.some((ref) => /^m[0-9]{5,}$/.test(ref)),
      acpRefSamples,
      sessionFile: session.sessionFile,
      sidecar,
      sidecarExists,
      sidecarHasBlocks: Array.isArray(sidecarJson?.blocks) && sidecarJson.blocks.length > 0,
      sidecarBlockCount: Array.isArray(sidecarJson?.blocks) ? sidecarJson.blocks.length : 0,
      sidecarBytes: sidecarExists ? readFileSync(sidecar, "utf8").length : 0,
      compressCalls: countToolCalls("compress"),
      secondCompressCalls: session.messages.filter(
        (message) =>
          Array.isArray(message.content) &&
          message.content.some(
            (part) =>
              part?.type === "toolCall" &&
              part.name === "compress" &&
              JSON.stringify(part.arguments ?? {}).includes("s1-second-checkpoint"),
          ),
      ).length,
      secondSummaryVisible: text.includes("S1-SECOND-COMPRESSED-SENTINEL"),
      decompressCalls: countToolCalls("decompress"),
      searchCalls: countToolCalls("search_context"),
      decompressRestoresSentinel: toolResultText("decompress").includes("PROJECT_PATH="),
      searchFindsBlock: toolResultText("search_context").includes("s1-synthetic-checkpoint"),
      summaryVisible: text.includes("S1-COMPRESSED-SENTINEL"),
      nativeCompactions: session.sessionManager
        .getEntries()
        .filter((entry) => entry.type === "compaction").length,
      sessionMessageCount: session.messages.length,
      sessionMessageRoles: session.messages.map((message) => message.role),
    };

    function check(name, ok, detail) {
      report.checks.push({ name, ok: Boolean(ok), detail });
      if (!ok) report.errors.push({ check: name, detail });
    }

    check("pi_host_detected", tools.length > 0, { toolCount: tools.length });
    check("no_acp_delegate_tools", !tools.some((tool) => tool.startsWith("acp_delegate")), tools);
    check("context_tools_registered", ["compress", "decompress", "search_context", "acp_status"].every((tool) => tools.includes(tool)), tools);
    check("acp_refs_present", report.observations.containsAcpRef, report.observations.acpRefSamples);
    check("sidecar_written", sidecarExists && report.observations.sidecarBytes > 0, sidecar);
    check("native_compaction_not_owned_by_pi", report.observations.nativeCompactions === 0, report.observations.nativeCompactions);
    check("compress_tool_executed", report.observations.compressCalls > 0, report.observations.compressCalls);
    check("compressed_block_persisted", report.observations.sidecarBlockCount > 0, report.observations.sidecarBlockCount);
    check("compressed_summary_visible", report.observations.summaryVisible, report.observations.summaryVisible);
    check("decompress_tool_executed", report.observations.decompressCalls > 0, report.observations.decompressCalls);
    check("decompress_restores_content", report.observations.decompressRestoresSentinel, report.observations.decompressRestoresSentinel);
    check("search_tool_executed", report.observations.searchCalls > 0, report.observations.searchCalls);
    check("search_finds_block", report.observations.searchFindsBlock, report.observations.searchFindsBlock);
    check("repeated_compression_executed", report.observations.secondCompressCalls > 0, report.observations.secondCompressCalls);
    check("second_block_persisted", report.observations.sidecarBlockCount >= 2, report.observations.sidecarBlockCount);
    check("second_summary_visible", report.observations.secondSummaryVisible, report.observations.secondSummaryVisible);

    const previousFile = session.sessionFile;
    const previousToolCount = tools.length;
    unsubscribe();
    await session.dispose();
    session = undefined;

    const reopenedManager = pi.SessionManager.open(previousFile, SESSION_DIR, PROJECT_DIR);
    const reopenedLoader = makeLoader();
    await reopenedLoader.reload();
    const reopened = await pi.createAgentSession({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      modelRuntime,
      model,
      sessionManager: reopenedManager,
      settingsManager,
      resourceLoader: reopenedLoader,
      tools: ["compress", "decompress", "search_context", "acp_status", "acp_cache"],
    });
    session = reopened.session;
    session.setActiveToolsByName(["compress", "decompress", "search_context", "acp_status", "acp_cache"]);
    await session.prompt(
      `RESTART S1. Continue the unfinished acceptance note. SESSION_A_SENTINEL=only-project-A. ` +
        `The adapter must restore its own state from the sidecar.`,
    );
    await session.waitForIdle?.();
    const after = readCapturedRequests(capturePath).filter((request) => !request.summary);
    const afterTools = [...new Set(after.flatMap(toolNamesOf))];
    const afterLast = after.at(-1);
    const afterText = messagesText(afterLast);
    const afterSidecarPath = `${previousFile}.acp.json`;
    let afterSidecarJson;
    try {
      afterSidecarJson = JSON.parse(readFileSync(afterSidecarPath, "utf8"));
    } catch {
      afterSidecarJson = undefined;
    }
    report.observations.restart = {
      requestCount: after.length,
      toolCount: afterTools.length,
      sidecarStillExists: existsSync(afterSidecarPath),
      blockCount: Array.isArray(afterSidecarJson?.blocks) ? afterSidecarJson.blocks.length : 0,
      summaryVisible: afterText.includes("S1-COMPRESSED-SENTINEL"),
      sessionFile: session.sessionFile,
    };
    check(
      "restart_keeps_adapter_tools",
      afterTools.length >= previousToolCount && afterTools.includes("compress"),
      afterTools,
    );
    check("restart_keeps_sidecar", existsSync(`${previousFile}.acp.json`), `${previousFile}.acp.json`);
    check(
      "restart_keeps_compressed_summary",
      report.observations.restart.summaryVisible && report.observations.restart.blockCount > 0,
      report.observations.restart,
    );
  } finally {
    unsubscribe();
    if (session) await session.dispose();
    await mock.close();
    report.finishedAt = new Date().toISOString();
    report.status = report.errors.length === 0 ? "PASS" : "FAIL";
    writeFileSync(join(REPORT_DIR, `s1-acp-${RUN_ID}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify(
        {
          status: report.status,
          runId: RUN_ID,
          report: join(REPORT_DIR, `s1-acp-${RUN_ID}.json`),
          checks: report.checks,
          observations: {
            lastToolNames: report.observations.lastToolNames,
            acpRefSamples: report.observations.acpRefSamples,
            sidecarExists: report.observations.sidecarExists,
            nativeCompactions: report.observations.nativeCompactions,
          },
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error) => {
  console.error(`S1_FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
