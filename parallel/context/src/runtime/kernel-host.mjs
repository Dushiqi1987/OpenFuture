import { createCore, createInitialState, defaultConfig } from "acp-kernel";
import { sha256 } from "./atomic-json.mjs";
import {
  blockTouchesRevoked,
  estimateCoreTokens,
  filterCoreMessages,
  projectPiMessages,
  toPiMessages,
} from "./projection.mjs";
import { RevocationSet } from "./revocation.mjs";
import { loadHostState, saveHostState, sidecarPath } from "./state-store.mjs";

function nowIso() {
  return new Date().toISOString();
}

function blocksOf(state) {
  if (Array.isArray(state?.blocks)) return state.blocks;
  if (state?.blocks && typeof state.blocks === "object") return Object.values(state.blocks);
  return [];
}

function initialContentStore() {
  return { version: 1, byHash: {}, byRef: {} };
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function withTimeout(promise, timeoutMs) {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return promise;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error("ACP_HOST_TIMEOUT")), timeoutMs);
      timer.unref?.();
    }),
  ]);
}

/**
 * Host-owned adapter around acp-kernel. It deliberately owns:
 *   - the Pi -> CoreMessage projection (revocation before projection),
 *   - the kernel state and JSON sidecar,
 *   - the final outbound filter (revocation after projection),
 *   - the fallback decision back to Pi native compaction.
 */
export class KernelHost {
  constructor({
    projectId,
    sessionId,
    storeRoot,
    sidecarFile,
    modelContextLimit = 2400,
    core,
    config,
    timeoutMs = 1500,
    debug = false,
  }) {
    if (!projectId) throw new Error("projectId is required");
    if (!sessionId) throw new Error("sessionId is required");
    this.projectId = projectId;
    this.sessionId = sessionId;
    this.storeRoot = storeRoot;
    this.sidecarFile = sidecarFile ?? sidecarPath(storeRoot, projectId, sessionId);
    this.modelContextLimit = modelContextLimit;
    this.core = core ?? createCore();
    this.config =
      config ??
      defaultConfig(modelContextLimit, {
        protectedTools: [],
        preserveRecentMessages: 2,
        preserveRecentTokens: 300,
      });
    this.state = createInitialState();
    this.contentStore = initialContentStore();
    this.revocations = new RevocationSet();
    this.invalidatedBlocks = new Set();
    this.revision = 0;
    this.mode = "acp";
    this.fallbackReason = null;
    this.debug = debug;
    this.timeoutMs = timeoutMs;
    this.lastProjected = [];
    this.lastSignature = null;
    this.lastResult = null;
    this.persistError = null;
    this.restored = false;
  }

  static open(options) {
    const host = new KernelHost(options);
    host.restore();
    return host;
  }

  restore() {
    this.restored = true;
    const loaded = loadHostState(this.sidecarFile, {
      projectId: this.projectId,
      sessionId: this.sessionId,
    });
    if (!loaded.ok) {
      this.mode = "native";
      this.fallbackReason = `SIDECAR_${loaded.reason ?? "INVALID"}`;
      return { ok: false, reason: this.fallbackReason };
    }
    if (loaded.missing) return { ok: true, missing: true };

    const value = loaded.value;
    if (!value.state || typeof value.state !== "object" || !value.contentStore) {
      this.mode = "native";
      this.fallbackReason = "SIDECAR_STATE_SHAPE_INVALID";
      return { ok: false, reason: this.fallbackReason };
    }
    this.state = value.state;
    this.contentStore = value.contentStore;
    this.revocations = RevocationSet.fromJSON(value.revocations);
    this.invalidatedBlocks = new Set(Array.isArray(value.invalidatedBlocks) ? value.invalidatedBlocks : []);
    this.revision = Number.isInteger(value.revision) ? value.revision : 0;
    this.mode = "acp";
    this.fallbackReason = null;
    return { ok: true, value };
  }

  persist() {
    try {
      saveHostState(this.sidecarFile, {
        projectId: this.projectId,
        sessionId: this.sessionId,
        revision: this.revision,
        state: this.state,
        contentStore: this.contentStore,
        revocations: this.revocations.toJSON(),
        invalidatedBlocks: [...this.invalidatedBlocks].sort(),
        stats: {
          mode: this.mode,
          lastPersistAt: nowIso(),
          ...(this.fallbackReason ? { fallbackReason: this.fallbackReason } : {}),
        },
      });
      this.persistError = null;
      return { ok: true };
    } catch (error) {
      this.persistError = error.message;
      this.mode = "native";
      this.fallbackReason = `SIDECAR_WRITE_FAILED: ${error.message}`;
      return { ok: false, reason: this.fallbackReason };
    }
  }

  snapshotMessages(piMessages) {
    try {
      return sha256(JSON.stringify(piMessages));
    } catch {
      return sha256(`${piMessages?.length ?? 0}:${Date.now()}:${Math.random()}`);
    }
  }

  /**
   * Called from the Pi context hook. Returning mode="native" tells the caller
   * to leave Pi's messages untouched so native compaction can take over.
   */
  async process(piMessages) {
    if (this.mode !== "acp") {
      return {
        ok: false,
        mode: "native",
        messages: piMessages,
        fallbackReason: this.fallbackReason,
      };
    }

    const signature = this.snapshotMessages(piMessages);
    if (signature === this.lastSignature && this.lastResult) {
      return { ...this.lastResult, duplicateSuppressed: true };
    }

    const projected = projectPiMessages(piMessages, { revocations: this.revocations });
    this.lastProjected = projected;
    const tokenCount = estimateCoreTokens(projected);

    try {
      const result = await withTimeout(
        Promise.resolve().then(() =>
          this.core.processTurn({
            messages: projected,
            state: this.state,
            config: this.config,
            tokenCount,
            renderTags: "none",
            contentStore: this.contentStore,
          }),
        ),
        this.timeoutMs,
      );

      this.state = result.state ?? this.state;
      if (result.contentStore) this.contentStore = result.contentStore;
      this.invalidateBlocks();

      const filtered = filterCoreMessages(result.messages ?? [], {
        state: this.state,
        revocations: this.revocations,
        invalidatedBlocks: this.invalidatedBlocks,
      });
      const outbound = toPiMessages(filtered, this.state, { revocations: this.revocations });
      const persisted = this.persist();
      if (!persisted.ok) {
        return { ok: false, mode: "native", messages: piMessages, fallbackReason: persisted.reason };
      }

      this.lastSignature = signature;
      this.lastResult = {
        ok: true,
        mode: "acp",
        messages: outbound,
        nudge: result.nudge,
        tokenCount,
        buildMs: 0,
      };
      return this.lastResult;
    } catch (error) {
      this.mode = "native";
      this.fallbackReason = `ACP_PROCESS_FAILED: ${error.message}`;
      this.lastSignature = null;
      this.persist();
      return {
        ok: false,
        mode: "native",
        messages: piMessages,
        fallbackReason: this.fallbackReason,
      };
    }
  }

  toRef(value) {
    if (!value) return undefined;
    const byRef = this.state?.messageRefs?.byRef ?? {};
    if (byRef[value]) return value;
    const mapped = this.state?.messageRefs?.byRaw?.[value];
    if (mapped) return typeof mapped === "string" ? mapped : mapped.ref;
    return undefined;
  }

  /**
   * Apply a model-authored compression range. Ranges use kernel refs
   * (startRef/endRef); raw message ids are accepted only as a convenience.
   */
  applyCompression({ ranges, protectedMessageIds } = {}) {
    if (this.mode !== "acp") {
      return { ok: false, code: "FALLBACK_NATIVE", reason: this.fallbackReason };
    }
    if (!Array.isArray(ranges) || ranges.length === 0) {
      return { ok: false, code: "INVALID_RANGES", reason: "at least one range is required" };
    }

    const normalized = [];
    for (const range of ranges) {
      const startRef = this.toRef(range.startRef ?? range.startId);
      const endRef = this.toRef(range.endRef ?? range.endId);
      if (!startRef || !endRef) {
        return {
          ok: false,
          code: "UNKNOWN_REF",
          reason: `range ${range.startRef ?? range.startId}..${range.endRef ?? range.endId} not found`,
        };
      }
      if (!range.summary || typeof range.summary !== "string") {
        return { ok: false, code: "INVALID_SUMMARY", reason: "summary must be a non-empty string" };
      }
      normalized.push({
        startRef,
        endRef,
        summary: range.summary,
        topic: range.topic,
        summaryMaxChars: range.summaryMaxChars,
      });
    }

    try {
      const before = cloneJson(this.state);
      const result = this.core.applyCompression({
        ranges: normalized,
        messages: this.lastProjected,
        state: this.state,
        config: this.config,
        protectedMessageIds,
      });
      if ((result.result?.blocksCreated ?? 0) === 0) {
        this.state = before;
        return {
          ok: false,
          code: "COMPRESSION_REJECTED",
          reason: result.result?.errors?.join("; ") || "kernel created no block",
          errors: result.result?.errors ?? [],
          warnings: result.result?.warnings ?? [],
        };
      }
      this.state = result.state;
      this.lastSignature = null;
      this.lastResult = null;
      this.revision += 1;
      this.invalidateBlocks();
      const persisted = this.persist();
      if (!persisted.ok) {
        this.state = before;
        this.mode = "native";
        return { ok: false, code: "SIDECAR_WRITE_FAILED", reason: persisted.reason };
      }
      return { ok: true, ...result.result, revision: this.revision };
    } catch (error) {
      return { ok: false, code: "COMPRESSION_FAILED", reason: error.message };
    }
  }

  invalidateBlocks() {
    for (const block of blocksOf(this.state)) {
      if (blockTouchesRevoked(block, this.revocations)) {
        this.invalidatedBlocks.add(block.blockId);
        if (typeof block === "object") block.active = false;
      }
    }
  }

  revoke(ids = [], texts = []) {
    const changed = this.revocations.revoke(ids, texts);
    if (!changed) return { ok: true, changed: false, revision: this.revision };
    this.revision += 1;
    this.invalidateBlocks();
    this.purgeContentStore();
    this.lastSignature = null;
    this.lastResult = null;
    this.persist();
    return {
      ok: true,
      changed: true,
      revision: this.revision,
      invalidatedBlocks: [...this.invalidatedBlocks],
    };
  }

  purgeContentStore() {
    const refsToDrop = new Set();
    for (const blockId of this.invalidatedBlocks) {
      const block = blocksOf(this.state).find((item) => item.blockId === blockId);
      if (!block) continue;
      for (const id of block.effectiveMessageIds ?? []) {
        const ref = this.state?.messageRefs?.byRaw?.[id];
        if (typeof ref === "string") refsToDrop.add(ref);
        else if (ref?.ref) refsToDrop.add(ref.ref);
      }
    }
    for (const ref of refsToDrop) {
      if (this.contentStore?.byRef) delete this.contentStore.byRef[ref];
    }
    return refsToDrop.size;
  }

  decompress(blockId, { full = false } = {}) {
    if (this.invalidatedBlocks.has(blockId)) {
      return { ok: false, code: "REVOKED_BLOCK", reason: "block was invalidated by revocation" };
    }
    const block = blocksOf(this.state).find((item) => item.blockId === blockId);
    if (!block) return { ok: false, code: "BLOCK_NOT_FOUND" };
    if (blockTouchesRevoked(block, this.revocations)) {
      return { ok: false, code: "REVOKED_BLOCK" };
    }
    try {
      const value = this.core.decompress(blockId, this.state);
      const text = JSON.stringify(value);
      if (this.revocations.containsText(text)) {
        return { ok: false, code: "REVOKED_CONTENT" };
      }
      return { ok: true, blockId, full, value };
    } catch (error) {
      return { ok: false, code: "DECOMPRESS_FAILED", reason: error.message };
    }
  }

  search(query) {
    try {
      const result = this.core.search(query, this.state);
      const text = JSON.stringify(result);
      if (this.revocations.containsText(text)) {
        return { ok: false, code: "REVOKED_CONTENT" };
      }
      return { ok: true, result };
    } catch (error) {
      return { ok: false, code: "SEARCH_FAILED", reason: error.message };
    }
  }

  status(tokenCount = 0) {
    let kernelStatus;
    try {
      kernelStatus = this.core.status(this.state, tokenCount, this.config);
    } catch (error) {
      kernelStatus = { error: error.message };
    }
    return {
      mode: this.mode,
      fallbackReason: this.fallbackReason,
      projectId: this.projectId,
      sessionId: this.sessionId,
      revision: this.revision,
      invalidatedBlocks: [...this.invalidatedBlocks].sort(),
      blocks: blocksOf(this.state).map((block) => ({
        blockId: block.blockId,
        topic: block.topic,
        active: block.active !== false,
        compressedTokens: block.compressedTokens,
        startRef: block.startRef,
        endRef: block.endRef,
      })),
      kernel: kernelStatus,
      persistError: this.persistError,
    };
  }

  listBlocks() {
    return blocksOf(this.state);
  }

  refFor(rawId) {
    return this.toRef(rawId);
  }

  lastProjectedMessages() {
    return this.lastProjected;
  }
}
