/**
 * Small line-based LCS diff used for the pre-publish review step.
 * It is deliberately dependency-free and deterministic; wiki pages are small,
 * so the quadratic table is bounded (see MAX_CELLS).
 */

const MAX_CELLS = 4_000_000;

export function diffLines(before, after, { context = 3 } = {}) {
  const beforeLines = splitLines(before);
  const afterLines = splitLines(after);
  const n = beforeLines.length;
  const m = afterLines.length;

  const ops = [];
  if (n * m > MAX_CELLS) {
    // Very large inputs: fall back to a whole-file replacement rather than
    // spending unbounded memory. Wiki pages normally stay far below this.
    for (let i = 0; i < n; i += 1) ops.push({ type: "del", oldLine: i + 1, text: beforeLines[i] });
    for (let j = 0; j < m; j += 1) ops.push({ type: "add", newLine: j + 1, text: afterLines[j] });
  } else {
    const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i -= 1) {
      for (let j = m - 1; j >= 0; j -= 1) {
        lcs[i][j] =
          beforeLines[i] === afterLines[j]
            ? lcs[i + 1][j + 1] + 1
            : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
      }
    }
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (beforeLines[i] === afterLines[j]) {
        ops.push({ type: "context", oldLine: i + 1, newLine: j + 1, text: beforeLines[i] });
        i += 1;
        j += 1;
      } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
        ops.push({ type: "del", oldLine: i + 1, text: beforeLines[i] });
        i += 1;
      } else {
        ops.push({ type: "add", newLine: j + 1, text: afterLines[j] });
        j += 1;
      }
    }
    while (i < n) {
      ops.push({ type: "del", oldLine: i + 1, text: beforeLines[i] });
      i += 1;
    }
    while (j < m) {
      ops.push({ type: "add", newLine: j + 1, text: afterLines[j] });
      j += 1;
    }
  }

  const added = ops.filter((op) => op.type === "add").length;
  const removed = ops.filter((op) => op.type === "del").length;
  const hunks = buildHunks(ops, context);
  return {
    changed: added > 0 || removed > 0,
    added,
    removed,
    beforeLines: n,
    afterLines: m,
    hunks,
  };
}

function splitLines(value) {
  const text = String(value ?? "").replace(/\r\n?/g, "\n");
  if (text === "") return [];
  return text.replace(/\n$/, "").split("\n");
}

function buildHunks(ops, context) {
  const keep = new Array(ops.length).fill(false);
  ops.forEach((op, index) => {
    if (op.type === "context") return;
    for (let offset = Math.max(0, index - context); offset <= Math.min(ops.length - 1, index + context); offset += 1) {
      keep[offset] = true;
    }
  });
  const hunks = [];
  let current = null;
  ops.forEach((op, index) => {
    if (!keep[index]) {
      current = null;
      return;
    }
    if (!current) {
      current = { ops: [] };
      hunks.push(current);
    }
    current.ops.push(op);
  });
  return hunks;
}

export function renderUnifiedDiff(diff, { beforeLabel = "published", afterLabel = "draft" } = {}) {
  const lines = [`--- ${beforeLabel}`, `+++ ${afterLabel}`];
  for (const hunk of diff.hunks) {
    const first = hunk.ops[0];
    const last = hunk.ops[hunk.ops.length - 1];
    const oldStart = first.oldLine ?? last.oldLine ?? 0;
    const newStart = first.newLine ?? last.newLine ?? 0;
    const oldCount = hunk.ops.filter((op) => op.type !== "add").length;
    const newCount = hunk.ops.filter((op) => op.type !== "del").length;
    lines.push(`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`);
    for (const op of hunk.ops) {
      const prefix = op.type === "add" ? "+" : op.type === "del" ? "-" : " ";
      lines.push(`${prefix}${op.text}`);
    }
  }
  return lines.join("\n");
}

export function summarizeDiff(diff) {
  return {
    changed: diff.changed,
    added: diff.added,
    removed: diff.removed,
    hunks: diff.hunks.length,
    beforeLines: diff.beforeLines,
    afterLines: diff.afterLines,
  };
}
