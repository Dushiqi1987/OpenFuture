import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = join(import.meta.dirname, '..')
const OUT = join(ROOT, '.scratch', 'rag-corpus')
const DOCS = join(OUT, 'docs')

const TOPICS = [
  { key: 'storage', name: '存储引擎', code: 'HALCYON' },
  { key: 'network', name: '网络栈', code: 'MARLIN' },
  { key: 'auth', name: '鉴权服务', code: 'ORCHID' },
  { key: 'scheduler', name: '调度器', code: 'PELICAN' },
  { key: 'billing', name: '计费系统', code: 'QUARTZ' },
  { key: 'search', name: '检索服务', code: 'RAVEN' },
  { key: 'media', name: '媒体转码', code: 'SABLE' },
  { key: 'cache', name: '缓存层', code: 'TUNDRA' },
  { key: 'metrics', name: '监控指标', code: 'UMBRA' },
  { key: 'backup', name: '灾备恢复', code: 'VESPER' }
]

const OWNERS = ['陈默', '林夏', '周航', '许知远', '赵岚', '钱屿', '孙可', '李澈', '吴桐', '郑遥']

const BOILERPLATE = [
  '所有生产变更必须先经过灰度发布，回滚窗口不超过十五分钟。',
  '本手册中列出的参数以当前稳定版为准，历史版本请查阅归档目录。',
  '任何阈值调整都需要在变更单中记录原因、影响范围与观测指标。',
  '告警必须同时配置值班人与升级路径，禁止只发到个人邮箱。'
]

function docBody(topic, index) {
  const code = `${topic.code}-${String(index + 1).padStart(3, '0')}`
  const threshold = topicIndex(topic) * 10 + index + 10
  const owner = OWNERS[index % OWNERS.length]
  const chapter = index + 1
  const noise = [
    `## 1. 服务概览\n\n${topic.name}第 ${chapter} 章覆盖 ${code} 的日常运维。该服务部署在双可用区，健康检查路径为 \`/healthz\`。`,
    `## 2. 关键参数\n\n- 服务代码：${code}\n- 默认阈值：${threshold} 秒\n- 负责人：${owner}\n- 变更窗口：每周三 02:00–04:00`,
    `## 3. 已知限制\n\n${BOILERPLATE[index % BOILERPLATE.length]}\n\n${BOILERPLATE[(index + 2) % BOILERPLATE.length]}`,
    `## 4. 排障步骤\n\n1. 先确认 ${code} 的健康检查返回 200。\n2. 再检查最近一次发布是否修改了 ${topic.name} 的阈值。\n3. 若指标持续异常，联系 ${owner} 并附带最近十分钟的日志。`
  ]
  return `# ${topic.name}运维手册 第 ${chapter} 章：${code}\n\n${noise.join('\n\n')}\n`
}

function topicIndex(topic) {
  return TOPICS.findIndex((item) => item.key === topic.key)
}

function writeCorpus() {
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(DOCS, { recursive: true })
  const docs = []
  for (const topic of TOPICS) {
    for (let index = 0; index < 10; index += 1) {
      const fileName = `${topic.key}-${String(index + 1).padStart(2, '0')}.md`
      writeFileSync(join(DOCS, fileName), docBody(topic, index), 'utf8')
      docs.push({
        fileName,
        topic: topic.key,
        topicName: topic.name,
        code: `${topic.code}-${String(index + 1).padStart(3, '0')}`,
        threshold: topicIndex(topic) * 10 + index + 10
      })
    }
  }
  return docs
}

function buildQueries(docs) {
  const queries = []
  for (const doc of docs) {
    queries.push({
      id: `exact-${doc.fileName}`,
      type: 'exact',
      query: `${doc.code} 的默认阈值是多少`,
      gold: [doc.fileName]
    })
    queries.push({
      id: `value-${doc.fileName}`,
      type: 'value',
      query: `哪个服务的默认阈值是 ${doc.threshold} 秒`,
      gold: [doc.fileName]
    })
  }
  for (let index = 0; index < docs.length; index += 5) {
    const first = docs[index]
    const second = docs[(index + 37) % docs.length]
    queries.push({
      id: `compare-${first.fileName}-${second.fileName}`,
      type: 'compare',
      query: `${first.code} 与 ${second.code} 的默认阈值分别是多少`,
      gold: [first.fileName, second.fileName]
    })
  }
  for (const doc of docs.filter((_, index) => index % 10 === 3)) {
    queries.push({
      id: `paraphrase-${doc.fileName}`,
      type: 'paraphrase',
      query: `${doc.topicName} 第 ${Number(doc.fileName.slice(-5, -3))} 章的超时配置`,
      gold: [doc.fileName]
    })
  }
  return queries
}

const docs = writeCorpus()
const queries = buildQueries(docs)
writeFileSync(join(OUT, 'queries.json'), JSON.stringify({ docs, queries }, null, 2), 'utf8')
console.log(`corpus ready: ${docs.length} docs, ${queries.length} queries -> ${OUT}`)
