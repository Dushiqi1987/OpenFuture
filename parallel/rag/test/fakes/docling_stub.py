#!/usr/bin/env python3
"""Deterministic Docling protocol double for client tests.

The real worker needs docling + models; this stub emits the same envelope shape
so the TypeScript client's parsing, error handling and timeout paths can be
tested on any machine. It never imports docling.
"""
import json
import sys

request = json.loads(sys.stdin.read() or "{}")
path = str(request.get("path") or "")

if "broken" in path:
    print(json.dumps({"ok": False, "error": {"code": "PARSE_FAILED", "message": "stub conversion failed"}}))
    sys.exit(0)

pages = [
    {
        "page": 1,
        "text": "Specification\n型号 OF-2200 Pro\n保修 36 个月",
        "ocr": "not-needed",
        "quality": 1.0,
    },
    {
        "page": 2,
        "text": "扫描页：备份配置需在升级前导出。",
        "ocr": "performed",
        "quality": 0.6,
    },
]
blocks = [
    {"id": "b-1-0", "page": 1, "kind": "heading", "text": "Specification", "level": 1, "charStart": 0, "charEnd": 13},
    {"id": "b-1-1", "page": 1, "kind": "paragraph", "text": "型号 OF-2200 Pro", "charStart": 14, "charEnd": 26},
    {"id": "b-1-2", "page": 1, "kind": "table", "text": "保修 36 个月", "charStart": 27, "charEnd": 37},
    {"id": "b-2-0", "page": 2, "kind": "paragraph", "text": "扫描页：备份配置需在升级前导出。", "charStart": 0, "charEnd": 18},
]
document = {
    "parser": "docling",
    "parserVersion": "docling/stub",
    "fileName": request.get("fileName") or "stub.pdf",
    "pages": pages,
    "blocks": blocks,
    "warnings": [],
}
print(json.dumps({"ok": True, "version": "stub", "document": document, "hybridChunks": [
    {"text": "Specification 型号 OF-2200 Pro 保修 36 个月", "page": 1, "headings": ["Specification"], "tokens": 12}
]}))
