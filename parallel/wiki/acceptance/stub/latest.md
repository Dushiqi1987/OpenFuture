# Wiki 适配器独立验收报告

- 结果：**通过**
- 模式：stub
- 服务端：`D:\OpenFuture-parallel\wiki\parallel\wiki\test\fixtures\stub-wiki-server.mjs`
- 时间：2026-11-09T08:15:39.848Z → 2026-11-09T08:15:41.620Z
- 检查：27/27 通过

| # | 检查 | 结果 | 证据 |
|---|------|------|------|
| 1 | bootstrap creates .llm-wiki/config.json | PASS | C:\Users\杜世旗\AppData\Local\Temp\openfuture-wiki-accept-rpB0AX\proj-alpha-9b5403\vault\.llm-wiki\config.json |
| 2 | server identifies as pi-llm-wiki over stdio | PASS | 0.12.5-stub |
| 3 | capture src-arch -> published source page | PASS | {"sourceId":"SRC-2026-11-09-001","affectedTopicIds":["topic-runtime"]} |
| 4 | capture src-workflow -> published source page | PASS | {"sourceId":"SRC-2026-11-09-002","affectedTopicIds":["topic-runtime"]} |
| 5 | capture src-wiki -> published source page | PASS | {"sourceId":"SRC-2026-11-09-003","affectedTopicIds":["topic-wiki"]} |
| 6 | capture routes changes only to topics that list the source | PASS |  |
| 7 | ingest reports that captured packets are already synthesized | PASS | {"mode":"none","firstLine":"No uningested source packets. Capture a source first."} |
| 8 | lint runs against the real vault layout | PASS | # Wiki Lint — 2026-11-09 |
| 9 | compile produces per-paragraph citations | PASS | {"paragraphs":5,"evidenceCount":4} |
| 10 | evidence DTO is JSON-serializable and fully locatable | PASS | {"evidenceId":"EV-topic-runtime-src-arch-0","projectId":"proj-alpha","topicId":"topic-runtime","sourceId":"SRC-2026-11-09-001","sourceRevision":"r1","logicalSourceId":"src-arch","title":"OpenFuture 并行交付架构说明（合成）","locator":{"type":"char_range","start":0,"end":64},"quote":"OpenFuture 采用主线与并行工作区分离的交付架构 |
| 11 | publishing without a reviewed plan is rejected | PASS | REVIEW_PLAN_REQUIRED |
| 12 | first publish shows an all-added diff and waits for review | PASS | {"added":100,"removed":0} |
| 13 | publish writes a readable, published topic page | PASS | {"pageId":"syntheses/openfuture-并行交付架构-c7100903","hash":"19d58410261b5f0ddd494d9ffd4f58ab66c3e42d7af13493c75b2b50d21ab6b1"} |
| 14 | a consumed review plan cannot be replayed | PASS | REVIEW_PLAN_REQUIRED |
| 15 | recall returns published project pages with previews | PASS | ["syntheses/openfuture-并行交付架构-c7100903.md","sources/SRC-2026-11-09-001.md","sources/SRC-2026-11-09-002.md"] |
| 16 | adding one source updates only its topic | PASS | {"added":42,"removed":5} |
| 17 | same-title topics keep stable, unique page ids | PASS | {"base":"syntheses/openfuture-并行交付架构-c7100903","alias":"syntheses/openfuture-并行交付架构-f3480382"} |
| 18 | replacing a source revokes the old packet and reports the affected topic | PASS | {"oldPacket":"SRC-2026-11-09-002","newPacket":"SRC-2026-11-09-005"} |
| 19 | replacing a source hides the old topic page and voids its plan | PASS | {"publish":"REVIEW_PLAN_REQUIRED","read":"not_published"} |
| 20 | replacement recompiles the topic against revision r2 only | PASS | {"added":14,"removed":14} |
| 21 | revoking a source hides its topic and rejects stale evidence | PASS | {"read":"not_published","tampered":"stale_evidence","rejected":{"outsideVault":0,"notPublished":1,"notActive":0,"foreignProject":0,"staleEvidence":1,"unreadable":0}} |
| 22 | revoking the only source revokes its topic and removes it from recall | PASS | {"rejected":{"outsideVault":0,"notPublished":1,"notActive":0,"foreignProject":0,"staleEvidence":0,"unreadable":0},"added":7,"removed":47} |
| 23 | unaffected topic page is byte-identical after other-topic revoke | PASS | topic-runtime page untouched; topic-wiki page revoked |
| 24 | recall rejects pages outside the project vault without leaking content | PASS | {"outsideVault":1,"notPublished":0,"notActive":0,"foreignProject":0,"staleEvidence":0,"unreadable":0} |
| 25 | readPublished refuses paths outside the vault | PASS | outside_vault |
| 26 | readPublished and recall reject a junction escape by physical path | PASS | {"read":"outside_vault","rawCount":0,"rejected":{"outsideVault":0,"notPublished":0,"notActive":0,"foreignProject":0,"staleEvidence":0,"unreadable":0}} |
| 27 | separate projects do not leak into each other's recall | PASS | {"alphaMatches":0,"betaMatches":2} |

## Diff 样例

```diff
--- syntheses/openfuture-并行交付架构-c7100903
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
