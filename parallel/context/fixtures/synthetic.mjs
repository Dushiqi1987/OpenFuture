export const FACTS = {
  projectPath: "PROJECT_PATH=D:\\OpenFuture-parallel\\context",
  modelId: "MODEL_ID=openfuture-mock/synthetic-s0",
  apiContract: "API_CONTRACT=POST /v1/chat/completions (OpenAI-compatible, local 127.0.0.1 only)",
  toolFailure: "FAILURE_CODE=MOCK_TOOL_FAILURE_EXPECTED",
  nextTask: "NEXT_TASK_SENTINEL=write the S0/S1 acceptance note and rerun on a machine with Node 22.19+",
  revoked: "REVOKED_SENTINEL=project-A-private-budget-4711",
  sessionA: "SESSION_A_SENTINEL=only-project-A",
  sessionB: "SESSION_B_SENTINEL=only-project-B",
};

export function filler(turn, width = 900) {
  const seed = `turn-${turn}-`;
  return (seed + "The local mock model is used only to exercise compaction mechanics. ").repeat(
    Math.ceil(width / 80),
  );
}

export function s0Turns() {
  return [
    `TURN 1. ${FACTS.projectPath}. ${FACTS.modelId}. ${FACTS.apiContract}. ${FACTS.nextTask}. ${filler(1)}`,
    `TURN 2. Call the mock_probe tool with label fail-once. Record ${FACTS.toolFailure}. ${filler(2)}`,
    `TURN 3. Keep the API contract and the failed tool result in the checkpoint. ${filler(3)}`,
    `TURN 4. ${FACTS.nextTask}. ${filler(4)}`,
    `TURN 5. Continue the unfinished acceptance note. ${filler(5)}`,
  ];
}

export function s1Turns(prefix = "A") {
  return [
    `TURN 1 ${prefix}. ${FACTS.sessionA}. ${FACTS.projectPath}. ${filler(1)}`,
    `TURN 2 ${prefix}. ${FACTS.sessionB}. ${filler(2)}`,
    `TURN 3 ${prefix}. ${FACTS.nextTask}. ${filler(3)}`,
    `TURN 4 ${prefix}. Continue the same task after the context manager runs. ${filler(4)}`,
    `TURN 5 ${prefix}. The next checkpoint must keep the API contract. ${FACTS.apiContract}. ${filler(5)}`,
    `TURN 6 ${prefix}. Confirm the summary and continue the unfinished acceptance note. ${filler(6)}`,
    `TURN 7 ${prefix}. Keep the current project isolated from the other session. ${filler(7)}`,
    `TURN 8 ${prefix}. Finish the checkpoint and leave the next action explicit. ${filler(8)}`,
  ];
}
