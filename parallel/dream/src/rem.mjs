/**
 * Phase 3: REM — cross-session clustering, timeline, counterexamples and
 * conflict retention. Pure and deterministic; no model calls.
 *
 * A conflict keeps BOTH sides (value, basis, session, timestamp, evidenceIds)
 * even after a correction resolves which value is current. The losing side is
 * never erased, so later review can see where the disagreement came from.
 */

import { normalizeKey, shortId, sortByKey } from './util.mjs'

const TYPE_ORDER = ['fact', 'preference', 'decision', 'rule', 'lesson', 'open-question']

function strongestBasis(bases) {
  if (bases.includes('user-confirmed')) return 'user-confirmed'
  if (bases.includes('tool-result')) return 'tool-result'
  return 'model-statement'
}

function atOf(candidate) {
  const value = candidate.at
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function valueCluster(candidate) {
  return {
    valueKey: normalizeKey(candidate.value),
    value: candidate.value,
    candidateIds: [],
    evidenceIds: new Set(),
    sessions: new Set(),
    sessionIds: [],
    bases: [],
    timestamps: [],
    counterexamples: []
  }
}

function finalizeValue(cluster) {
  return {
    valueKey: cluster.valueKey,
    value: cluster.value,
    candidateIds: [...new Set(cluster.candidateIds)].sort(),
    evidenceIds: [...cluster.evidenceIds].sort(),
    sessionIds: [...new Set(cluster.sessionIds)].sort(),
    basis: strongestBasis(cluster.bases),
    firstSeenAt: cluster.timestamps.length ? Math.min(...cluster.timestamps) : null,
    lastSeenAt: cluster.timestamps.length ? Math.max(...cluster.timestamps) : null,
    counterexamples: [...new Set(cluster.counterexamples)].sort()
  }
}

/**
 * @param {{projectId:string, candidates:any[], entries?:any[]}} input
 */
export function buildRem({ projectId, candidates, entries = [] }) {
  const groups = new Map()
  for (const candidate of candidates) {
    const subjectKey = candidate.subjectKey ?? normalizeKey(candidate.subject)
    if (!groups.has(subjectKey)) {
      groups.set(subjectKey, {
        subjectKey,
        subject: candidate.subject,
        types: new Set(),
        values: new Map(),
        sessions: new Set(),
        candidates: []
      })
    }
    const group = groups.get(subjectKey)
    group.types.add(candidate.type)
    group.sessions.add(candidate.sessionId)
    group.candidates.push(candidate.id)
    const valueKey = normalizeKey(candidate.value)
    if (!group.values.has(valueKey)) group.values.set(valueKey, valueCluster(candidate))
    const cluster = group.values.get(valueKey)
    cluster.candidateIds.push(candidate.id)
    for (const evidenceId of candidate.evidenceIds ?? []) cluster.evidenceIds.add(evidenceId)
    if (candidate.sessionId) {
      cluster.sessions.add(candidate.sessionId)
      cluster.sessionIds.push(candidate.sessionId)
    }
    cluster.bases.push(candidate.basis)
    if (atOf(candidate)) cluster.timestamps.push(atOf(candidate))
    if (candidate.counterexample === true) cluster.counterexamples.push(candidate.id)
  }

  const entryBySubject = new Map()
  for (const entry of entries) {
    entryBySubject.set(normalizeKey(entry.subject ?? entry.title ?? ''), entry)
  }

  const clusters = []
  const conflicts = []
  for (const group of groups.values()) {
    const values = sortByKey(
      [...group.values.values()].map(finalizeValue),
      (value) => value.valueKey
    )
    const typeCandidates = group.candidates
    const resolvedEntry = entryBySubject.get(group.subjectKey) ?? null
    const type = TYPE_ORDER.find((candidateType) => group.types.has(candidateType)) ?? 'fact'
    const cluster = {
      id: shortId('cluster', { projectId, subjectKey: group.subjectKey }),
      projectId,
      subject: group.subject,
      subjectKey: group.subjectKey,
      type,
      types: [...group.types].sort(),
      candidateIds: [...new Set(typeCandidates)].sort(),
      values,
      sessionIds: [...new Set(group.sessions)].sort(),
      sessionCount: group.sessions.size,
      crossSession: group.sessions.size > 1,
      firstSeenAt: values.reduce((min, value) => (value.firstSeenAt === null ? min : min === null ? value.firstSeenAt : Math.min(min, value.firstSeenAt)), null),
      lastSeenAt: values.reduce((max, value) => (value.lastSeenAt === null ? max : max === null ? value.lastSeenAt : Math.max(max, value.lastSeenAt)), null),
      counterexamples: [...new Set(values.flatMap((value) => value.counterexamples))].sort(),
      entryId: resolvedEntry?.id ?? null,
      entryValue: resolvedEntry?.value ?? null,
      alignedWithEntry:
        resolvedEntry === null
          ? null
          : values.length === 1 && normalizeKey(resolvedEntry.value) === values[0].valueKey
    }
    clusters.push(cluster)

    if (values.length > 1) {
      const corrections = candidates
        .filter(
          (candidate) =>
            candidate.subjectKey === group.subjectKey &&
            candidate.type === 'correction' &&
            candidate.previousValue
        )
        .sort((a, b) => atOf(a) - atOf(b) || normalizeKey(a.value).localeCompare(normalizeKey(b.value)))
      const sides = values.map((value) => ({
        value: value.value,
        valueKey: value.valueKey,
        evidenceIds: value.evidenceIds,
        sessionIds: value.sessionIds,
        basis: value.basis,
        firstSeenAt: value.firstSeenAt,
        lastSeenAt: value.lastSeenAt,
        counterexamples: value.counterexamples
      }))
      const conflict = {
        id: shortId('conflict', {
          projectId,
          subjectKey: group.subjectKey,
          sides: sides.map((side) => side.valueKey).sort()
        }),
        projectId,
        subject: group.subject,
        subjectKey: group.subjectKey,
        clusterId: cluster.id,
        type,
        sides,
        status: 'unresolved',
        resolution: null,
        resolvedValue: null,
        counterexamples: cluster.counterexamples
      }
      if (corrections.length > 0) {
        const correction = corrections[corrections.length - 1]
        const previousKey = normalizeKey(correction.previousValue)
        const targetKey = normalizeKey(correction.value)
        if (sides.some((side) => side.valueKey === previousKey) && sides.some((side) => side.valueKey === targetKey)) {
          conflict.status = 'resolved-by-correction'
          conflict.resolution = {
            kind: 'correction',
            correctionValue: correction.value,
            previousValue: correction.previousValue,
            evidenceIds: [...new Set(correction.evidenceIds ?? [])].sort(),
            sessionId: correction.sessionId ?? null,
            at: atOf(correction) || null
          }
          conflict.resolvedValue = correction.value
          cluster.entryValue ??= correction.value
        }
      }
      conflicts.push(conflict)
      cluster.conflictId = conflict.id
    }
  }

  const themes = TYPE_ORDER.filter((type) => clusters.some((cluster) => cluster.types.includes(type))).map(
    (type) => ({
      type,
      subjects: clusters
        .filter((cluster) => cluster.types.includes(type))
        .map((cluster) => cluster.subject)
        .sort(),
      count: clusters.filter((cluster) => cluster.types.includes(type)).length
    })
  )

  return {
    projectId,
    at: Date.now(),
    clusters: sortByKey(clusters, (cluster) => cluster.subjectKey),
    conflicts: sortByKey(conflicts, (conflict) => conflict.subjectKey),
    themes,
    collections: {
      crossSession: sortByKey(
        clusters.filter((cluster) => cluster.crossSession),
        (cluster) => cluster.subjectKey
      ),
      counterexamples: sortByKey(
        clusters.filter((cluster) => cluster.counterexamples.length > 0),
        (cluster) => cluster.subjectKey
      ),
      unresolved: sortByKey(
        conflicts.filter((conflict) => conflict.status === 'unresolved'),
        (conflict) => conflict.subjectKey
      )
    },
    stats: {
      clusters: clusters.length,
      conflicts: conflicts.length,
      unresolved: conflicts.filter((conflict) => conflict.status === 'unresolved').length,
      counterexamples: clusters.reduce((count, cluster) => count + cluster.counterexamples.length, 0),
      sessions: new Set(clusters.flatMap((cluster) => cluster.sessionIds)).size
    }
  }
}

/**
 * Optional Wiki draft update. It is a DRAFT only: this worker never writes the
 * wiki. The main line may show it to the publisher next to the memory plan.
 */
export function proposeWikiDraft({ projectId, rem, existingWiki = null, now = Date.now() }) {
  const lines = [
    `# Wiki draft — ${existingWiki?.title ?? 'Project memory review'}`,
    '',
    `Generated ${new Date(now).toISOString()} from ${rem.clusters.length} cross-session cluster(s).`,
    'Status: draft only; not applied.',
    ''
  ]
  for (const cluster of rem.clusters) {
    const current = cluster.entryValue ?? cluster.values[0]?.value ?? ''
    lines.push(`## ${cluster.subject}`)
    lines.push('')
    lines.push(`- Current: ${current}`)
    for (const value of cluster.values) {
      lines.push(
        `- Seen: ${value.value} (${value.basis}; sessions: ${value.sessionIds.join(', ') || 'unknown'}; evidence: ${value.evidenceIds.join(', ') || 'none'})`
      )
    }
    const conflict = rem.conflicts.find((item) => item.clusterId === cluster.id)
    if (conflict) {
      lines.push(`- Conflict: ${conflict.status}${conflict.resolvedValue ? ` -> ${conflict.resolvedValue}` : ''}`)
    }
    lines.push('')
  }
  return {
    projectId,
    status: 'draft',
    title: existingWiki?.title ?? 'Project memory review',
    baseRevision: existingWiki?.revision ?? null,
    markdown: lines.join('\n'),
    clusterIds: rem.clusters.map((cluster) => cluster.id),
    generatedAt: now
  }
}
