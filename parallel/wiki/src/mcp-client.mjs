import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

/**
 * Minimal, dependency-free MCP stdio client for pi-llm-wiki 0.12.5.
 *
 * The server speaks newline-delimited JSON-RPC 2.0 on stdin/stdout (one JSON
 * object per line). stdout is protocol-only; diagnostics are collected from
 * stderr and never mixed into the protocol stream.
 */

export class McpProtocolError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "McpProtocolError";
    Object.assign(this, details);
  }
}

export class McpToolError extends Error {
  constructor(tool, text, raw) {
    super(`MCP tool ${tool} failed: ${text}`);
    this.name = "McpToolError";
    this.tool = tool;
    this.text = text;
    this.raw = raw;
  }
}

export class StdioMcpClient {
  #nextId = 1;
  #pending = new Map();
  #buffer = "";
  #closed = false;
  #child = null;
  #stderr = "";
  #exitPromise = null;

  constructor({
    serverPath,
    nodePath = process.execPath,
    cwd = process.cwd(),
    env = {},
    timeoutMs = 30_000,
    maxStderrBytes = 32_768,
    clientName = "openfuture-parallel-wiki",
    clientVersion = "0.1.0",
  } = {}) {
    if (!serverPath) throw new Error("serverPath is required");
    this.serverPath = serverPath;
    this.nodePath = nodePath;
    this.cwd = cwd;
    this.env = env;
    this.timeoutMs = timeoutMs;
    this.maxStderrBytes = maxStderrBytes;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.serverInfo = null;
    this.capabilities = null;
  }

  get pid() {
    return this.#child?.pid ?? null;
  }

  get stderr() {
    return this.#stderr;
  }

  get closed() {
    return this.#closed;
  }

  async start() {
    if (!existsSync(this.serverPath)) {
      throw new McpProtocolError(`MCP server not found: ${this.serverPath}`, {
        code: "WIKI_SERVER_NOT_FOUND",
      });
    }
    if (!existsSync(this.nodePath)) {
      throw new McpProtocolError(`Node runtime not found: ${this.nodePath}`, {
        code: "WIKI_NODE_NOT_FOUND",
      });
    }

    const child = spawn(this.nodePath, [this.serverPath], {
      cwd: this.cwd,
      env: { ...process.env, ...this.env },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#child = child;

    this.#exitPromise = new Promise((resolve) => {
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });

    child.on("error", (error) => {
      this.#failAll(
        new McpProtocolError(`MCP server process error: ${error.message}`, {
          code: "WIKI_SERVER_SPAWN_FAILED",
          cause: error,
        }),
      );
    });

    child.once("exit", (code, signal) => {
      this.#closed = true;
      this.#failAll(
        new McpProtocolError(`MCP server exited (code=${code}, signal=${signal})`, {
          code: "WIKI_SERVER_EXITED",
          exitCode: code,
          signal,
        }),
      );
    });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => this.#onStdout(chunk));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      this.#stderr = (this.#stderr + chunk).slice(-this.maxStderrBytes);
    });

    const init = await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: this.clientName, version: this.clientVersion },
    });
    this.notify("notifications/initialized", {});
    this.serverInfo = init?.serverInfo ?? null;
    this.capabilities = init?.capabilities ?? null;
    return this;
  }

  #onStdout(chunk) {
    this.#buffer += chunk;
    while (true) {
      const newline = this.#buffer.indexOf("\n");
      if (newline === -1) break;
      const line = this.#buffer.slice(0, newline).replace(/\r$/, "").trim();
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        // Keep non-protocol stdout out of the JSON-RPC path; it is useful in
        // diagnostics if a server version prints a banner to the wrong stream.
        this.#stderr = `${this.#stderr}\n[stdout-non-json] ${line}`.slice(-this.maxStderrBytes);
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (!message || typeof message !== "object") return;
    if (message.id !== undefined && (Object.hasOwn(message, "result") || Object.hasOwn(message, "error"))) {
      const pending = this.#pending.get(message.id);
      if (!pending) return;
      this.#pending.delete(message.id);
      clearTimeout(pending.timer);
      if (message.error) {
        pending.reject(
          new McpProtocolError(
            `MCP ${pending.method} error ${message.error.code ?? "?"}: ${message.error.message ?? "unknown"}`,
            { code: "WIKI_RPC_ERROR", rpcError: message.error, method: pending.method },
          ),
        );
      } else {
        pending.resolve(message.result);
      }
      return;
    }
    // Server-initiated notifications (logging/progress) are intentionally not
    // surfaced as data; they are ignored so they cannot corrupt tool results.
  }

  #failAll(error) {
    for (const [id, pending] of this.#pending) {
      this.#pending.delete(id);
      clearTimeout(pending.timer);
      pending.reject(error);
    }
  }

  #write(payload) {
    if (this.#closed || !this.#child?.stdin?.writable) {
      throw new McpProtocolError("MCP server stdin is closed", { code: "WIKI_SERVER_CLOSED" });
    }
    try {
      this.#child.stdin.write(`${JSON.stringify(payload)}\n`);
    } catch (error) {
      throw new McpProtocolError(`Cannot write to MCP server: ${error.message}`, {
        code: "WIKI_SERVER_WRITE_FAILED",
        cause: error,
      });
    }
  }

  request(method, params, { timeoutMs = this.timeoutMs } = {}) {
    if (this.#closed) {
      return Promise.reject(
        new McpProtocolError("MCP server is not running", { code: "WIKI_SERVER_CLOSED" }),
      );
    }
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(
          new McpProtocolError(`MCP request timed out after ${timeoutMs}ms: ${method}`, {
            code: "WIKI_RPC_TIMEOUT",
            method,
            timeoutMs,
          }),
        );
      }, timeoutMs);
      if (typeof timer.unref === "function") timer.unref();
      this.#pending.set(id, { resolve, reject, timer, method });
      try {
        this.#write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(error);
      }
    });
  }

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  async listTools() {
    const result = await this.request("tools/list", {});
    return result?.tools ?? [];
  }

  async callTool(name, args = {}, options = {}) {
    const result = await this.request("tools/call", { name, arguments: args }, options);
    const text = extractText(result);
    if (result?.isError) throw new McpToolError(name, text, result);
    return { text, raw: result, structured: result?.structuredContent ?? null };
  }

  async close() {
    if (!this.#child) return;
    if (this.#closed) return;
    this.#closed = true;
    this.#failAll(new McpProtocolError("MCP client closed", { code: "WIKI_CLIENT_CLOSED" }));
    try {
      this.#child.stdin.end();
    } catch {
      // Ignore: the process may already be gone.
    }
    const exited = await Promise.race([
      this.#exitPromise,
      new Promise((resolve) => setTimeout(() => resolve(null), 1_000)),
    ]);
    if (exited === null) {
      try {
        this.#child.kill();
      } catch {
        // Ignore.
      }
    }
  }
}

export function extractText(result) {
  const content = result?.content;
  if (Array.isArray(content)) {
    const text = content
      .filter((item) => item && item.type === "text" && typeof item.text === "string")
      .map((item) => item.text)
      .join("\n");
    if (text) return text;
  }
  if (result?.structuredContent !== undefined) {
    return JSON.stringify(result.structuredContent);
  }
  return "";
}

/** Parse a JSON tool response that may be wrapped in prose. */
export function parseJsonText(text) {
  if (typeof text !== "string" || text.trim() === "") return null;
  const trimmed = text.trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    // pi-llm-wiki returns JSON.stringify(..., null, 2); a server variant may
    // prefix a status line. Extract the first balanced JSON object/array.
    const start = trimmed.search(/[[{]/);
    if (start === -1) return null;
    const opening = trimmed[start];
    const closing = opening === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < trimmed.length; i += 1) {
      const char = trimmed[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === "\\") escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') inString = true;
      else if (char === opening) depth += 1;
      else if (char === closing) {
        depth -= 1;
        if (depth === 0) {
          try {
            return JSON.parse(trimmed.slice(start, i + 1));
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}
