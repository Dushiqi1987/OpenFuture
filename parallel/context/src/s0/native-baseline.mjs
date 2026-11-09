import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { startMockServer } from "../../fixtures/mock-model/server.mjs";
import { FACTS, s0Turns } from "../../fixtures/synthetic.mjs";

const ROOT = resolve(fileURLToPath(new URL("../../", import.meta.url)));
const RUN_ID = new Date().toISOString().replace(/[:.]/g, "-");
const RUN_DIR = join(ROOT, ".scratch", "s0", RUN_ID);
const AGENT_DIR = join(RUN_DIR, "agent");
const PROJECT_DIR = join(RUN_DIR, "project");
const SESSION_DIR = join(RUN_DIR, "sessions");
const REPORT_DIR = join(ROOT, "reports");
const MOCK_PORT = Number(process.env.S0_MOCK_PORT ?? 19745);
const TURNS = s0Turns();

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
            id: "synthetic-s0",
            name: "Synthetic S0",
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

function eventRecord(event) {
  const record = { type: event?.type, at: new Date().toISOString() };
  if (event?.type === "compaction_start") {
    record.reason = event.reason;
  } else if (event?.type === "compaction_end") {
    record.reason = event.reason;
    record.aborted = event.aborted;
    record.willRetry = event.willRetry;
    record.errorMessage = event.errorMessage;
    record.tokensBefore = event.result?.tokensBefore;
    record.firstKeptEntryId = event.result?.firstKeptEntryId;
    record.summaryChars = event.result?.summary?.length;
  } else if (event?.type === "entry_appended") {
    record.entryType = event.entry?.type;
    record.entryId = event.entry?.id;
  } else if (event?.type === "auto_retry_start" || event?.type === "auto_retry_end") {
    record.attempt = event.attempt;
  } else if (event?.type === "session_compact_failed") {
    record.reason = event.reason;
    record.errorMessage = event.errorMessage;
    record.aborted = event.aborted;
    record.willRetry = event.willRetry;
  }
  return record;
}

function compactionEntries(manager) {
  return manager.getEntries().filter((entry) => entry.type === "compaction");
}

function snapshot(session, turn) {
  const manager = session.sessionManager;
  const entries = manager.getEntries();
  return {
    turn,
    at: new Date().toISOString(),
    messageCount: session.messages.length,
    entryCount: entries.length,
    compactionEntries: compactionEntries(manager).map((entry) => ({
      id: entry.id,
      firstKeptEntryId: entry.firstKeptEntryId,
      tokensBefore: entry.tokensBefore,
      summaryChars: entry.summary?.length ?? 0,
      fromHook: entry.fromHook,
    })),
    contextUsage: session.getContextUsage?.(),
    stats: session.getSessionStats?.(),
  };
}

async function main() {
  ensureDirs();
  writeIsolatedModelConfig();

  let pi;
  try {
    pi = await import("@earendil-works/pi-coding-agent");
  } catch (error) {
    console.error(
      [
        "S0_NOT_RUN: @earendil-works/pi-coding-agent is not importable.",
        `cause: ${error.code ?? error.message}`,
        "run: cd parallel/context && pnpm install --ignore-scripts",
        "then: pnpm run s0",
      ].join("\n"),
    );
    process.exitCode = 2;
    return;
  }

  const mock = await startMockServer({
    port: MOCK_PORT,
    host: "127.0.0.1",
    capturePath: join(ROOT, ".scratch", "captures", `s0-${RUN_ID}.jsonl`),
  });

  const report = {
    status: "RUNNING",
    runId: RUN_ID,
    startedAt: new Date().toISOString(),
    ports: { mock: MOCK_PORT },
    paths: { runDir: RUN_DIR, sessionDir: SESSION_DIR },
    model: { provider: "openfuture-mock", id: "synthetic-s0", contextWindow: 1600 },
    config: { compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 500 } },
    turns: TURNS.length,
    events: [],
    snapshots: [],
    checks: [],
    errors: [],
  };

  const modelRuntime = await pi.ModelRuntime.create({
    authPath: join(AGENT_DIR, "auth.json"),
    modelsPath: join(AGENT_DIR, "models.json"),
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const model = modelRuntime.getModel("openfuture-mock", "synthetic-s0");
  if (!model) throw new Error("S0 model openfuture-mock/synthetic-s0 was not loaded from isolated models.json");

  const settingsManager = pi.SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 512, keepRecentTokens: 500 },
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
      extensionFactories: [],
    });
  }

  const mockProbe = {
    name: "mock_probe",
    label: "Mock probe",
    description: "Returns the deterministic synthetic failure used by the S0 baseline.",
    parameters: (await import("typebox")).Type.Object({ label: (await import("typebox")).Type.String() }),
    async execute(_toolCallId, params) {
      throw new Error(`${FACTS.toolFailure} label=${params?.label ?? "unset"}`);
    },
  };

  let session;
  let unsubscribe = () => {};
  try {
    const sessionManager = pi.SessionManager.create(PROJECT_DIR, SESSION_DIR);
    const created = await pi.createAgentSession({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      modelRuntime,
      model,
      sessionManager,
      settingsManager,
      resourceLoader: makeLoader(),
      noTools: "builtin",
      customTools: [mockProbe],
      tools: ["mock_probe"],
    });
    session = created.session;
    unsubscribe = session.subscribe((event) => {
      const record = eventRecord(event);
      if (record.type) report.events.push(record);
    });

    for (let index = 0; index < TURNS.length; index += 1) {
      await session.prompt(TURNS[index]);
      await session.waitForIdle?.();
      report.snapshots.push(snapshot(session, index + 1));
    }

    let extra = 0;
    while (compactionEntries(session.sessionManager).length < 2 && extra < 8) {
      extra += 1;
      await session.prompt(
        `TURN ${TURNS.length + extra}. Continue the unfinished acceptance note. ` +
          `NEXT_TASK_SENTINEL=write the S0/S1 acceptance note and rerun on a machine with Node 22.19+. ` +
          `EXTRA_${String(extra).padStart(2, "0")} ${"synthetic-compaction-pressure ".repeat(90)}`,
      );
      await session.waitForIdle?.();
      report.snapshots.push(snapshot(session, TURNS.length + extra));
    }

    const entries = session.sessionManager.getEntries();
    const compactions = compactionEntries(session.sessionManager);
    const firstUser = entries.find((entry) => entry.type === "message" && entry.message?.role === "user");
    const firstCompaction = compactions[0];
    const rawSession = readFileSync(session.sessionFile, "utf8");
    const originalHistoryPresent =
      rawSession.includes("PROJECT_PATH=") && rawSession.includes("NEXT_TASK_SENTINEL=");
    const firstKeptPresent =
      !firstCompaction || entries.some((entry) => entry.id === firstCompaction.firstKeptEntryId);
    const summaryText = compactions.map((entry) => entry.summary ?? "").join("\n");
    const summaryHasFacts =
      summaryText.includes("PROJECT_PATH=") &&
      summaryText.includes("NEXT_TASK_SENTINEL=") &&
      summaryText.includes("S0-SUMMARY-SENTINEL-");

    function check(name, ok, detail) {
      report.checks.push({ name, ok: Boolean(ok), detail });
      if (!ok) report.errors.push({ check: name, detail });
    }

    check("session_started", Boolean(session.sessionFile), session.sessionFile);
    check("first_user_entry_exists", Boolean(firstUser), firstUser?.id);
    check("auto_compaction_triggered", compactions.length >= 1, compactions.length);
    check("original_history_remains_readable", originalHistoryPresent, entries.length);
    check("first_kept_entry_id_resolves", firstKeptPresent, firstCompaction?.firstKeptEntryId);
    check("summary_retains_facts", summaryHasFacts, summaryText.slice(0, 500));
    check("repeated_compaction_triggered", compactions.length >= 2, compactions.length);

    const previousFile = session.sessionFile;
    const previousCompactions = compactions.length;
    unsubscribe();
    await session.dispose();
    session = undefined;

    const reopenedManager = pi.SessionManager.open(previousFile, SESSION_DIR, PROJECT_DIR);
    const reopened = await pi.createAgentSession({
      cwd: PROJECT_DIR,
      agentDir: AGENT_DIR,
      modelRuntime,
      model,
      sessionManager: reopenedManager,
      settingsManager,
      resourceLoader: makeLoader(),
      noTools: "builtin",
      customTools: [mockProbe],
      tools: ["mock_probe"],
    });
    session = reopened.session;
    unsubscribe = session.subscribe((event) => {
      const record = eventRecord(event);
      if (record.type) report.events.push({ ...record, afterRestart: true });
    });

    const reopenedEntries = reopenedManager.getEntries();
    const reopenedCompactions = compactionEntries(reopenedManager);
    check(
      "restart_preserves_entries",
      reopenedEntries.length >= entries.length && reopenedCompactions.length >= previousCompactions,
      { before: entries.length, after: reopenedEntries.length, compactions: reopenedCompactions.length },
    );

    await session.prompt(
      "RESTART CONTINUATION. Resume the unfinished acceptance note and keep the API contract. " +
        "NEXT_TASK_SENTINEL=write the S0/S1 acceptance note and rerun on a machine with Node 22.19+.",
    );
    await session.waitForIdle?.();
    const afterRestart = snapshot(session, "restart-continuation");
    report.snapshots.push(afterRestart);
    check(
      "restart_can_continue",
      session.messages.length > 0 && session.sessionManager.getEntries().length >= reopenedEntries.length,
      { messages: session.messages.length },
    );

    const otherManager = pi.SessionManager.create(PROJECT_DIR, SESSION_DIR);
    check(
      "new_session_is_isolated",
      otherManager.getSessionFile() !== previousFile &&
        !otherManager.getEntries().some((entry) => entry.id === firstUser?.id),
      otherManager.getSessionFile(),
    );
  } finally {
    unsubscribe();
    if (session) await session.dispose();
    await mock.close();
    report.finishedAt = new Date().toISOString();
    report.status = report.errors.length === 0 ? "PASS" : "FAIL";
    writeFileSync(join(REPORT_DIR, `s0-baseline-${RUN_ID}.json`), `${JSON.stringify(report, null, 2)}\n`, "utf8");
    console.log(
      JSON.stringify(
        {
          status: report.status,
          runId: RUN_ID,
          report: join(REPORT_DIR, `s0-baseline-${RUN_ID}.json`),
          checks: report.checks,
          compactions: report.snapshots.at(-1)?.compactionEntries?.length ?? 0,
        },
        null,
        2,
      ),
    );
  }
}

main().catch((error) => {
  console.error(`S0_FAILED: ${error.stack ?? error.message}`);
  process.exitCode = 1;
});
