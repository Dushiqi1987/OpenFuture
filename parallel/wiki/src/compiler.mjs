import { renderFrontmatter } from "./frontmatter.mjs";
import { sha256, safeId } from "./util.mjs";

/**
 * Deterministic extractive compiler.
 *
 * Every paragraph in the synthesized page is taken from exactly one published
 * source packet and ends with a citation marker. The evidence list is the
 * machine-readable projection of those markers, so the mainline can validate
 * a paragraph against its source revision and character range.
 */

const MAX_PARAGRAPHS_PER_SOURCE = 2;
const MAX_EVIDENCE = 8;
const MAX_PARAGRAPH_CHARS = 600;
const MAX_QUOTE_CHARS = 180;

export function splitParagraphs(text) {
  const normalized = String(text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!normalized) return [];
  const paragraphs = [];
  const pattern = /\n[ \t]*\n+/g;
  let start = 0;
  let match;
  const push = (from, to) => {
    const raw = normalized.slice(from, to);
    const trimmedStart = raw.length - raw.trimStart().length;
    const trimmedEnd = raw.trimEnd().length;
    const value = raw.slice(trimmedStart, trimmedEnd);
    if (!value) return;
    if (/^#{1,6}\s/.test(value)) return;
    paragraphs.push({ start: from + trimmedStart, end: from + trimmedEnd, text: value });
  };
  while ((match = pattern.exec(normalized)) !== null) {
    push(start, match.index);
    start = pattern.lastIndex;
  }
  push(start, normalized.length);
  return paragraphs;
}

function cjkBigrams(value) {
  const chars = [...value].filter((char) => /\p{Script=Han}/u.test(char));
  const grams = [];
  for (let i = 0; i < chars.length - 1; i += 1) grams.push(chars[i] + chars[i + 1]);
  return grams;
}

function keywordScore(paragraph, keywords) {
  const lower = paragraph.toLowerCase();
  const grams = new Set(cjkBigrams(paragraph));
  let score = 0;
  for (const raw of keywords) {
    const keyword = String(raw).toLowerCase().trim();
    if (!keyword) continue;
    if (/\p{Script=Han}/u.test(keyword)) {
      if (keyword.length >= 2 && grams.has(keyword)) score += 3;
      else if (lower.includes(keyword)) score += 3;
    } else {
      const words = lower.split(/[^\p{Letter}\p{Number}]+/u).filter(Boolean);
      if (words.includes(keyword)) score += 2;
      else if (lower.includes(keyword)) score += 1;
    }
  }
  return score;
}

function clipParagraph(text) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= MAX_PARAGRAPH_CHARS) return collapsed;
  const slice = collapsed.slice(0, MAX_PARAGRAPH_CHARS);
  const boundary = Math.max(slice.lastIndexOf("。"), slice.lastIndexOf(". "), slice.lastIndexOf("；"));
  return (boundary > MAX_PARAGRAPH_CHARS * 0.6 ? slice.slice(0, boundary + 1) : slice).trim();
}

function clipQuote(text) {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= MAX_QUOTE_CHARS
    ? collapsed
    : `${collapsed.slice(0, MAX_QUOTE_CHARS - 1)}…`;
}

function selectForSource(source, keywords, warnings) {
  const paragraphs = splitParagraphs(source.text);
  if (paragraphs.length === 0) {
    warnings.push(`source ${source.logicalId} has no extractable paragraph`);
    return [];
  }
  const scored = paragraphs.map((paragraph) => ({
    ...paragraph,
    score: keywordScore(paragraph.text, keywords),
  }));
  const hits = scored.filter((paragraph) => paragraph.score > 0);
  const chosen = (hits.length > 0 ? hits : scored.slice(0, 1))
    .sort((a, b) => b.score - a.score || a.start - b.start)
    .slice(0, MAX_PARAGRAPHS_PER_SOURCE);
  if (hits.length === 0) {
    warnings.push(`source ${source.logicalId} matched no topic keyword; used its first paragraph`);
  }
  return chosen.sort((a, b) => a.start - b.start);
}

export function compileTopic({ topic, sources, now = new Date().toISOString() }) {
  if (!topic?.id || !topic?.title) throw new Error("topic.id and topic.title are required");
  const warnings = [];
  const keywords = Array.isArray(topic.keywords) ? topic.keywords : [];
  const orderedSources = [...sources].sort((a, b) => String(a.logicalId).localeCompare(String(b.logicalId)));

  const candidates = [];
  for (const source of orderedSources) {
    const selected = selectForSource(source, keywords, warnings);
    for (const paragraph of selected) {
      candidates.push({ source, paragraph });
    }
  }
  candidates.sort((a, b) => b.paragraph.score - a.paragraph.score || a.paragraph.start - b.paragraph.start);
  const limited = candidates.slice(0, MAX_EVIDENCE);
  limited.sort(
    (a, b) =>
      orderedSources.findIndex((source) => source.logicalId === a.source.logicalId) -
        orderedSources.findIndex((source) => source.logicalId === b.source.logicalId) ||
      a.paragraph.start - b.paragraph.start,
  );

  const evidence = limited.map(({ source, paragraph }, index) => ({
    marker: index + 1,
    evidenceId: `EV-${safeId(topic.id)}-${safeId(source.logicalId)}-${paragraph.start}`,
    projectId: topic.projectId ?? null,
    topicId: topic.id,
    sourceId: source.packetId,
    sourceRevision: source.revision,
    logicalSourceId: source.logicalId,
    title: source.title,
    locator: { type: "char_range", start: paragraph.start, end: paragraph.end },
    quote: clipQuote(paragraph.text),
    _paragraph: paragraph,
  }));

  const coverage = orderedSources.map((source) => ({
    logicalSourceId: source.logicalId,
    sourceId: source.packetId,
    revision: source.revision,
    paragraphs: splitParagraphs(source.text).length,
    selected: evidence.filter((item) => item.logicalSourceId === source.logicalId).length,
  }));
  for (const item of coverage) {
    if (item.selected === 0) warnings.push(`source ${item.logicalSourceId} contributes no evidence`);
  }

  const today = now.slice(0, 10);
  const sourceEntries = [];
  for (const item of evidence) {
    let entry = sourceEntries.find((candidate) => candidate.id === `sources/${item.sourceId}`);
    if (!entry) {
      entry = {
        id: `sources/${item.sourceId}`,
        revision: item.sourceRevision,
        evidence_ids: [],
      };
      sourceEntries.push(entry);
    }
    entry.evidence_ids.push(item.evidenceId);
  }

  const paragraphs = evidence.map(
    (item) => `${clipParagraph(item._paragraph.text)} [${item.marker}]`,
  );
  const intro =
    evidence.length > 0
      ? `本主题综合 ${orderedSources.length} 份已发布资料，围绕“${topic.thesis ?? topic.title}”整理如下。` +
        ` ${evidence.map((item) => `[${item.marker}]`).join("")}`
      : `本主题当前没有可引用的已发布资料。`;

  const bodyLines = [`# ${topic.title}`, ""];
  if (topic.thesis) bodyLines.push(`> ${topic.thesis}`, "");
  bodyLines.push("## 主题综述", "", intro, "");
  if (paragraphs.length > 0) {
    bodyLines.push(...paragraphs.flatMap((paragraph) => [paragraph, ""]));
  }
  bodyLines.push("## 证据与出处", "");
  if (evidence.length === 0) {
    bodyLines.push("（无）", "");
  } else {
    for (const item of evidence) {
      bodyLines.push(
        `- [${item.marker}] \`sources/${item.sourceId}\` · ${item.logicalSourceId}@${item.sourceRevision} · 字符 ${item.locator.start}–${item.locator.end}`,
        `  > ${item.quote.replace(/\n/g, " ")}`,
      );
    }
    bodyLines.push("");
  }

  const frontmatter = {
    type: "synthesis",
    title: topic.title,
    description: topic.thesis ?? topic.title,
    status: "published",
    state: "active",
    project_id: topic.projectId ?? null,
    topic_id: topic.id,
    created: topic.createdAt?.slice(0, 10) ?? today,
    updated: today,
    generated: true,
    verified: false,
    sources: sourceEntries,
    evidence: evidence.map(({ marker, _paragraph, ...rest }) => rest),
  };

  const body = bodyLines.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n*$/, "");
  const markdown = renderFrontmatter(frontmatter, body);
  return {
    topicId: topic.id,
    title: topic.title,
    markdown,
    body,
    evidence: evidence.map(({ marker, _paragraph, ...rest }) => ({ marker, ...rest })),
    sources: sourceEntries,
    coverage,
    warnings,
    draftHash: sha256(markdown),
    evidenceCount: evidence.length,
  };
}
