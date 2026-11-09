export const SYNTHETIC_SUMMARY_PREFIX = "[ACP block ";
export const REDACTED_TEXT = "[历史内容已按撤销状态清理]";

export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .join("");
}

function shortHash(text) {
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function evidenceIdOf(message, index, role = message?.role) {
  if (typeof message?.evidenceId === "string" && message.evidenceId) return `ev:${message.evidenceId}`;
  if (typeof message?.id === "string" && message.id) return message.id;
  const text = contentText(message?.content);
  return `pi:${role}:${index}:${shortHash(text)}`;
}

export function isSyntheticSummary(message) {
  return contentText(message?.content).startsWith(SYNTHETIC_SUMMARY_PREFIX);
}

/**
 * Project Pi AgentMessage[] into acp-kernel CoreMessage[].
 *
 * Revocation happens before projection, so a revoked message never reaches
 * processTurn and therefore never reaches a summary request. Tool calls and
 * results are removed as a pair.
 */
export function projectPiMessages(piMessages, { revocations } = {}) {
  const messages = Array.isArray(piMessages) ? piMessages : [];
  const revokedToolCalls = new Set();
  const retained = [];

  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message || message.role === "system") continue;
    if (isSyntheticSummary(message)) continue;

    const messageId = evidenceIdOf(message, index);
    const revoked = revocations?.hasId?.(messageId) || false;

    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (block?.type === "toolCall" && revoked) revokedToolCalls.add(block.id);
      }
    }
    if (message.role === "toolResult" && revoked) {
      revokedToolCalls.add(message.toolCallId);
    }
    if (!revoked) retained.push({ index, message, messageId });
  }

  const out = [];
  for (const { index, message, messageId } of retained) {
    if (message.role === "user") {
      out.push({
        id: messageId,
        role: "user",
        contentType: "text",
        text: contentText(message.content),
      });
      continue;
    }

    if (message.role === "assistant" && Array.isArray(message.content)) {
      let textIndex = 0;
      for (const block of message.content) {
        if (block?.type === "text" && typeof block.text === "string" && block.text.length > 0) {
          out.push({
            id: `${messageId}:text:${textIndex++}`,
            role: "assistant",
            contentType: "text",
            text: block.text,
          });
        } else if (block?.type === "thinking" && typeof block.thinking === "string") {
          out.push({
            id: `${messageId}:thinking`,
            role: "assistant",
            contentType: "reasoning",
            text: block.thinking,
            thinkingTokens: Math.ceil(block.thinking.length / 4),
          });
        } else if (block?.type === "toolCall") {
          if (revokedToolCalls.has(block.id)) continue;
          out.push({
            id: `${messageId}:call:${block.id}`,
            role: "assistant",
            contentType: "tool-call",
            toolName: block.name,
            toolCallId: block.id,
            text: JSON.stringify(block.arguments ?? {}),
          });
        }
      }
      continue;
    }

    if (message.role === "toolResult") {
      if (revokedToolCalls.has(message.toolCallId)) continue;
      out.push({
        id: `${messageId}:result`,
        role: "tool",
        contentType: "tool-result",
        toolName: message.toolName,
        toolCallId: message.toolCallId,
        text: contentText(message.content),
      });
      continue;
    }

    if (message.role === "custom" || message.role === "branchSummary" || message.role === "compactionSummary") {
      out.push({
        id: messageId,
        role: "user",
        contentType: "text",
        text: contentText(message.content) || message.summary || "",
      });
    }
  }

  return out;
}

export function estimateCoreTokens(messages) {
  let chars = 0;
  for (const message of messages) {
    chars += (message.text ?? "").length;
    if (message.toolName) chars += message.toolName.length;
    if (message.toolCallId) chars += message.toolCallId.length;
  }
  return Math.max(1, Math.ceil(chars / 4));
}

export function blockTouchesRevoked(block, revocations) {
  if (!block || !revocations) return false;
  const ids = [
    ...(Array.isArray(block.effectiveMessageIds) ? block.effectiveMessageIds : []),
    ...(Array.isArray(block.directMessageIds) ? block.directMessageIds : []),
  ];
  return ids.some((id) => revocations.hasId?.(id) || revocations.hasPrefix?.(id));
}

export function findBlock(state, blockId) {
  const blocks = Array.isArray(state?.blocks) ? state.blocks : [];
  return blocks.find((block) => block.blockId === blockId);
}

/**
 * Final outbound gate. It runs after kernel processTurn, so a block that was
 * invalidated by revocation is dropped even if the kernel still retained it.
 * Tool results without a surviving tool call are dropped to keep the pair
 * invariant.
 */
export function filterCoreMessages(messages, { state, revocations, invalidatedBlocks } = {}) {
  const invalidated = invalidatedBlocks ?? new Set();
  const kept = [];
  for (const message of messages ?? []) {
    if (!message) continue;
    if (revocations?.hasId?.(message.id)) continue;
    if (message.summaryOfBlockId) {
      if (invalidated.has(message.summaryOfBlockId)) continue;
      const block = findBlock(state, message.summaryOfBlockId);
      if (blockTouchesRevoked(block, revocations)) continue;
      const text = block?.summary ?? message.text ?? "";
      if (revocations?.containsText?.(text)) continue;
      kept.push(message);
      continue;
    }
    const text = message.text ?? "";
    if (revocations?.containsText?.(text)) {
      if (message.contentType === "tool-result") continue;
      kept.push({ ...message, text: REDACTED_TEXT });
      continue;
    }
    kept.push(message);
  }

  const callIds = new Set(
    kept.filter((message) => message.contentType === "tool-call" && message.toolCallId).map((message) => message.toolCallId),
  );
  return kept.filter(
    (message) => message.contentType !== "tool-result" || (message.toolCallId && callIds.has(message.toolCallId)),
  );
}

function summaryTextFor(message, state) {
  const block = message.summaryOfBlockId ? findBlock(state, message.summaryOfBlockId) : undefined;
  const text = block?.summary ?? message.text ?? "";
  const topic = block?.topic ? ` ${block.topic}` : "";
  return `${SYNTHETIC_SUMMARY_PREFIX}${message.summaryOfBlockId ?? "unknown"}${topic}]\n${text}`;
}

function zeroUsage() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 };
}

function assistantMessage(blocks) {
  return {
    role: "assistant",
    content: blocks,
    api: "openai-completions",
    provider: "openfuture-mock",
    model: "synthetic",
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: Date.now(),
  };
}

/**
 * Convert kernel output back to Pi AgentMessage[]. Only text, tool calls, tool
 * results and compressed block summaries are rendered; system messages are
 * restored by Pi after the context hook and must not be returned here.
 */
export function toPiMessages(coreMessages, state, { revocations } = {}) {
  const out = [];
  const suppliedCallIds = new Set();
  for (const message of coreMessages ?? []) {
    if (message.contentType === "tool-call" && message.toolCallId) suppliedCallIds.add(message.toolCallId);
  }

  for (const message of coreMessages ?? []) {
    if (message.role === "system") continue;
    if (message.contentType === "reasoning") continue;
    if (revocations?.hasId?.(message.id)) continue;

    if (message.summaryOfBlockId) {
      const block = findBlock(state, message.summaryOfBlockId);
      if (blockTouchesRevoked(block, revocations)) continue;
      const text = summaryTextFor(message, state);
      if (revocations?.containsText?.(text)) continue;
      out.push({ role: "user", content: text, timestamp: Date.now() });
      continue;
    }

    if (message.contentType === "tool-call") {
      let args = {};
      try {
        args = JSON.parse(message.text ?? "{}");
      } catch {
        args = {};
      }
      out.push(
        assistantMessage([
          {
            type: "toolCall",
            id: message.toolCallId,
            name: message.toolName,
            arguments: args,
          },
        ]),
      );
      continue;
    }

    if (message.contentType === "tool-result") {
      if (!message.toolCallId || !suppliedCallIds.has(message.toolCallId)) continue;
      out.push({
        role: "toolResult",
        toolCallId: message.toolCallId,
        toolName: message.toolName,
        content: [{ type: "text", text: message.text ?? "" }],
        details: {},
        isError: false,
        timestamp: Date.now(),
      });
      continue;
    }

    if (message.contentType === "text" && message.role === "user") {
      const text = message.text ?? "";
      if (revocations?.containsText?.(text)) continue;
      out.push({ role: "user", content: text, timestamp: Date.now() });
      continue;
    }

    if (message.contentType === "text" && message.role === "assistant") {
      const text = message.text ?? "";
      if (revocations?.containsText?.(text)) continue;
      out.push(assistantMessage([{ type: "text", text }]));
    }
  }
  return out;
}
