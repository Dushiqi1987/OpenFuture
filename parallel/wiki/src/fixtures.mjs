/** Synthetic, non-secret materials used by tests and the acceptance run. */
export const SOURCES = {
  "src-arch": {
    title: "OpenFuture 并行交付架构说明（合成）",
    text: [
      "OpenFuture 采用主线与并行工作区分离的交付架构。主线保存正式配置、合入事务和最终校验，并行工作区只持有相对种子的增量。",
      "每个并行工作区有独立的 Git 种子和本地分支。worker 分支上的提交必须限定在约定的交付目录内，提交前要审查文件范围，禁止把根配置和其他工作区的改动带进来。",
      "适配器位于边界一侧，只产出可序列化的结果或待审计划。读取侧的校验、证据核对与提交事务由主线持有，适配器不能直接写正式配置。",
      "跨进程数据使用 projectId、sourceId、sourceRevision、evidenceId 和 locator 标识证据。locator 使用带类型的字符区间、行号或页码，保证引用可复核。",
      "并行任务使用专用测试端口和隔离的临时目录。所有外部依赖未就绪时，适配器返回可识别状态和回退证据，不阻塞对话，也不伪造成功。",
    ].join("\n\n"),
  },
  "src-workflow": {
    title: "OpenFuture 并行开发与合入流程（合成）",
    text: [
      "并行开发从固定种子创建本地 worker 分支。开发者只修改任务指定的交付目录，根目录的 src、正式配置和其他工作区保持只读。",
      "开发完成后先运行独立验收，再把相对种子的增量提交到本地分支。提交信息要写明验收命令和实际跑过的测试，未测项必须显式列出。",
      "Codex 负责审查分支增量、接口契约和证据完整性。审查通过后由主线串行合入，禁止并行任务自行推送或合入主线。",
      "合入前主线会重新执行验收，并核对每条主题证据的 projectId、sourceId、sourceRevision 和 locator。任何跨项目内容泄露都会阻止合入。",
    ].join("\n\n"),
  },
  "src-wiki": {
    title: "pi-llm-wiki 主题编译契约（合成）",
    text: [
      "每个项目使用独立的临时 vault。WIKI_ROOT 指向项目 vault，WIKI_HOME 指向隔离的假用户目录，避免读到真实个人页面或正式凭证。",
      "bootstrap 创建 .llm-wiki 目录和配置；capture 把合成资料写入 raw/sources 并生成来源页；ingest 返回待综合的批次；lint 检查页面和缺口；recall 返回命中的页面与预览。",
      "主题页由多个已发布来源编译而成。每个正文段落末尾带引用编号，证据列表记录来源包、修订、字符区间和引文，形成逐段可追溯的出处。",
      "发布前先展示 diff，发布后再更新主题页和元数据。新增、替换或撤销单个来源时，只重编译受影响的主题，其他主题的页面哈希保持不变。",
      "检索和读取只返回本项目、已发布且处于活跃状态的页面。已撤销、未发布或位于其他 vault 的命中必须被过滤，并给出不含正文的拒绝原因。",
    ].join("\n\n"),
  },
  "src-ops": {
    title: "并行验收与测试端口约定（合成）",
    text: [
      "并行验收使用专用测试端口 19732，需要第二个端口时使用 19742。只启动属于当前工作区的测试进程，不占用主线的端口和用户目录。",
      "验收数据全部使用合成资料、假凭证和临时目录。测试结束后清理临时 vault，不写正式配置，也不把测试数据提交到仓库。",
      "回滚流程保留来源修订历史。替换来源时旧来源页标记为已撤销，新修订重新进入主题编译；撤销来源时只更新引用该来源的主题。",
    ].join("\n\n"),
  },
};

export const REPLACEMENTS = {
  "src-workflow": {
    revision: "r2",
    title: "OpenFuture 并行开发与合入流程（合成，修订二）",
    text: [
      "并行开发从固定种子创建本地 worker 分支。开发者只修改任务指定的交付目录，根目录的 src、正式配置和其他工作区保持只读。",
      "修订二增加了回滚要求：如果验收失败，保留失败日志和来源修订号，回退本地提交，不得把未通过验收的增量交给主线。",
      "开发完成后先运行独立验收，再把相对种子的增量提交到本地分支。提交信息要写明验收命令和实际跑过的测试，未测项必须显式列出。",
      "Codex 负责审查分支增量、接口契约和证据完整性。审查通过后由主线串行合入，禁止并行任务自行推送或合入主线。",
      "合入前主线会重新执行验收，并核对每条主题证据的 projectId、sourceId、sourceRevision 和 locator。任何跨项目内容泄露都会阻止合入。",
    ].join("\n\n"),
  },
};

export const TOPICS = [
  {
    id: "topic-runtime",
    title: "OpenFuture 并行交付架构",
    thesis: "并行工作区以只读种子和本地分支为边界，主线保留校验与合入事务。",
    keywords: ["并行", "工作区", "分支", "提交", "审查", "合入", "架构", "适配器", "事务"],
    sourceIds: ["src-arch", "src-workflow"],
  },
  {
    id: "topic-wiki",
    title: "Wiki 主题编译契约",
    thesis: "每个项目独立 vault，主题页逐段引用已发布来源，发布前后可见 diff。",
    keywords: ["wiki", "vault", "捕获", "引用", "主题", "发布", "检索", "diff", "来源"],
    sourceIds: ["src-wiki"],
  },
];

export const FOREIGN_MARKER = "FOREIGN_ONLY_MARKER_9f3c";
