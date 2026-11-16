import { chunkText, estimateTokens, splitSentences } from '../src/memory-host/chunk.ts'

let failed = 0
const check = (label, condition, detail = '') => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}${detail ? ` -> ${detail}` : ''}`)
  if (!condition) failed += 1
}

const sentences = splitSentences('第一句。第二句！Third sentence? 数值 3.14 与 e.g. 缩写。')
check(
  'sentence split keeps decimals intact',
  sentences.every((sentence) => !sentence.startsWith('14')),
  JSON.stringify(sentences)
)
check('token estimate separates CJK and Latin', estimateTokens('中文四个字') === 5 && estimateTokens('hello world') === 3, `${estimateTokens('中文四个字')} / ${estimateTokens('hello world')}`)

const chinese = [
  '# 存储引擎运维手册 第 1 章：HALCYON-001',
  '',
  '## 1. 服务概览',
  '',
  '存储引擎第 1 章覆盖 HALCYON-001 的日常运维。该服务部署在双可用区，健康检查路径为 /healthz。负责人陈默。'.repeat(12),
  '',
  '## 2. 关键参数',
  '',
  '默认阈值 10 秒。变更窗口每周三 02:00–04:00。任何阈值调整都需要在变更单中记录原因、影响范围与观测指标。'.repeat(12),
  ''
].join('\n')

const chunks = chunkText(chinese)
check('chinese doc produces multiple chunks', chunks.length >= 2, `${chunks.length} chunks`)
check(
  'chinese chunks respect token cap',
  chunks.every((chunk) => estimateTokens(chunk.quote) <= 448),
  chunks.map((chunk) => estimateTokens(chunk.quote)).join(',')
)
check(
  'chinese chunks stay near 560 characters',
  chunks.every((chunk) => chunk.quote.length <= 600),
  `max ${Math.max(...chunks.map((chunk) => chunk.quote.length))}`
)
check(
  'headings start a chunk',
  chunks.some((chunk) => chunk.quote.startsWith('#')),
  chunks.map((chunk) => chunk.quote.slice(0, 10)).join(' | ')
)
check(
  'consecutive chunks overlap by a sentence',
  chunks.slice(1).some((chunk) => /^[^#\n]{12,}/.test(chunk.quote)),
  'overlap present'
)
check(
  'offsets stay inside the document',
  chunks.every((chunk) => chunk.start >= 0 && chunk.end <= chinese.length && chunk.start < chunk.end)
)

const english = [
  '# Introduction',
  '',
  'Severe acute respiratory syndrome coronavirus 2 (SARS-CoV-2) emerged in late 2019. '.repeat(60),
  ''
].join('\n')
const latin = chunkText(english)
check('english doc splits by token budget', latin.length >= 2, `${latin.length} chunks`)
check(
  'english chunk tokens stay under cap',
  latin.every((chunk) => estimateTokens(chunk.quote) <= 448),
  latin.map((chunk) => estimateTokens(chunk.quote)).join(',')
)
check(
  'english chunks end at sentence boundaries',
  latin.every((chunk) => /[.!?]["']?$/.test(chunk.quote.trim()) || /^#/.test(chunk.quote.trim())),
  JSON.stringify(latin.map((chunk) => chunk.quote.trim().slice(-16)))
)

const dense = '测试'.repeat(3_000)
const denseChunks = chunkText(dense)
check('oversized CJK paragraph hard-cuts', denseChunks.length >= 5, `${denseChunks.length} chunks`)
check(
  'hard-cut chunks fit the token cap',
  denseChunks.every((chunk) => estimateTokens(chunk.quote) <= 448),
  denseChunks.map((chunk) => estimateTokens(chunk.quote)).join(',')
)

const tiny = chunkText('# 标题\n\n短句。')
check('keeps a short document as one chunk', tiny.length === 1, `${tiny.length} chunks`)
check('empty text yields no chunk', chunkText('   \n\n').length === 0)

console.log(failed === 0 ? 'CHUNK SMOKE PASSED' : `CHUNK SMOKE FAILED (${failed})`)
process.exit(failed === 0 ? 0 : 1)
