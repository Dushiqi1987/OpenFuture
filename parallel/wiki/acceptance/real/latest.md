# Wiki 适配器独立验收报告

- 结果：**通过**
- 模式：real
- 服务端：`D:\OpenFuture-parallel\wiki\.scratch\real-wiki\node_modules\@zosmaai\pi-llm-wiki\dist\mcp\index.js`
- 时间：2026-11-09T07:46:02.623Z → 2026-11-09T07:46:16.193Z
- 检查：21/21 通过

| # | 检查 | 结果 | 证据 |
|---|------|------|------|
| 1 | bootstrap creates .llm-wiki/config.json | PASS | C:\Users\杜世旗\AppData\Local\Temp\openfuture-wiki-accept-wdAlqD\proj-alpha-9b5403\vault\.llm-wiki\config.json |
| 2 | server identifies as pi-llm-wiki over stdio | PASS | 1.0.0 |
| 3 | capture src-arch -> published source page | PASS | {"sourceId":"SRC-2026-11-09-001","affectedTopicIds":["topic-runtime"]} |
| 4 | capture src-workflow -> published source page | PASS | {"sourceId":"SRC-2026-11-09-002","affectedTopicIds":["topic-runtime"]} |
| 5 | capture src-wiki -> published source page | PASS | {"sourceId":"SRC-2026-11-09-003","affectedTopicIds":["topic-wiki"]} |
| 6 | capture routes changes only to topics that list the source | PASS |  |
| 7 | ingest reports that captured packets are already synthesized | PASS | {"mode":"none","firstLine":"✅ All sources ingested. Use wiki_capture_source to add new ones."} |
| 8 | lint runs against the real vault layout | PASS | 🧹 **LLM Wiki lint complete** |
| 9 | compile produces per-paragraph citations | PASS | {"paragraphs":5,"evidenceCount":4} |
| 10 | evidence DTO is JSON-serializable and fully locatable | PASS | {"evidenceId":"EV-topic-runtime-src-arch-0","projectId":"proj-alpha","topicId":"topic-runtime","sourceId":"SRC-2026-11-09-001","sourceRevision":"r1","logicalSourceId":"src-arch","title":"OpenFuture 并行交付架构说明（合成）","locator":{"type":"char_range","start":0,"end":64},"quote":"OpenFuture 采用主线与并行工作区分离的交付架构 |
| 11 | first publish shows an all-added diff and waits for review | PASS | {"added":100,"removed":0} |
| 12 | publish writes a readable, published topic page | PASS | {"pageId":"syntheses/openfuture-并行交付架构","hash":"19d58410261b5f0ddd494d9ffd4f58ab66c3e42d7af13493c75b2b50d21ab6b1"} |
| 13 | recall returns published project pages with previews | PASS | ["syntheses/openfuture-并行交付架构.md","sources/SRC-2026-11-09-001.md","sources/SRC-2026-11-09-002.md"] |
| 14 | adding one source updates only its topic | PASS | {"added":42,"removed":5} |
| 15 | replacing a source revokes the old packet and reports the affected topic | PASS | {"oldPacket":"SRC-2026-11-09-002","newPacket":"SRC-2026-11-09-005"} |
| 16 | replacement recompiles the topic against revision r2 only | PASS | {"added":14,"removed":14} |
| 17 | revoking the only source revokes its topic and removes it from recall | PASS | {"rejected":{"outsideVault":0,"notPublished":1,"notActive":0,"foreignProject":0,"unreadable":0},"added":7,"removed":47} |
| 18 | unaffected topic page is byte-identical after other-topic revoke | PASS | topic-runtime page untouched; topic-wiki page revoked |
| 19 | recall rejects pages outside the project vault without leaking content | PASS | {"outsideVault":1,"notPublished":0,"notActive":0,"foreignProject":0,"unreadable":0} |
| 20 | readPublished refuses paths outside the vault | PASS | outside_vault |
| 21 | separate projects do not leak into each other's recall | PASS | {"alphaMatches":0,"betaMatches":2} |

## Diff 样例

```diff
--- syntheses/openfuture-并行交付架构
+++ drafts/topic-runtime.md
@@ -16,6 +16,11 @@
     evidence_ids:
       - EV-topic-runtime-src-arch-0
       - EV-topic-runtime-src-arch-66
+  - id: sources/SRC-2026-11-09-004
+    revision: r1
+    evidence_ids:
+      - EV-topic-runtime-src-ops-0
+      - EV-topic-runtime-src-ops-68
   - id: sources/SRC-2026-11-09-002
```

