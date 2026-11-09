#!/usr/bin/env python3
"""Local Docling worker for the OpenFuture RAG prototype.

Protocol: one JSON object on stdin, one JSON object on stdout.

  {"path": "...pdf", "fileName": "...", "ocr": true, "chunkTokens": 700,
   "hybridChunking": true}

  {"ok": true, "version": "2.x", "document": {...}, "hybridChunks": [...]}

The worker never raises past main(): every failure becomes {"ok": false} so the
TypeScript client can surface a status instead of hanging the caller. Docling is
imported lazily, which keeps the "Docling not installed" path cheap.
"""
import importlib.metadata
import json
import os
import sys
import traceback


def emit(payload):
    print(json.dumps(payload, ensure_ascii=False))
    sys.stdout.flush()


def fail(code, message, detail=None):
    emit({"ok": False, "error": {"code": code, "message": message, "detail": detail}})
    return 0


def label_name(item):
    label = getattr(item, "label", None)
    if label is None:
        return "text"
    return str(getattr(label, "value", label))


def page_of(item):
    prov = getattr(item, "prov", None) or []
    for entry in prov:
        page_no = getattr(entry, "page_no", None)
        if page_no is not None:
            return int(page_no)
    return None


def item_text(item, label):
    if label == "table":
        try:
            return item.export_to_markdown()
        except Exception:
            pass
    text = getattr(item, "text", None)
    return text or ""


def build_document(doc, doc_version, ocr_enabled):
    page_numbers = sorted(int(page) for page in (getattr(doc, "pages", {}) or {}).keys())
    if not page_numbers:
        page_numbers = [1]
    texts = {page: [] for page in page_numbers}
    blocks = []
    cursor = {page: 0 for page in page_numbers}

    for item, level in doc.iterate_items():
        label = label_name(item)
        text = item_text(item, label).strip()
        if not text:
            continue
        page_no = page_of(item) or page_numbers[0]
        if page_no not in texts:
            texts[page_no] = []
            cursor[page_no] = 0
        if label == "table":
            kind = "table"
        elif label in ("section_header", "title"):
            kind = "heading"
        elif label == "list_item":
            kind = "list"
        else:
            kind = "paragraph"
        start = cursor[page_no]
        texts[page_no].append(text)
        cursor[page_no] = start + len(text) + 1
        block = {
            "id": "b-%d-%d" % (page_no, len(blocks)),
            "page": page_no,
            "kind": kind,
            "text": text,
            "charStart": start,
            "charEnd": start + len(text),
        }
        if kind == "heading":
            block["level"] = max(1, min(6, int(level or 1)))
        blocks.append(block)

    pages = []
    warnings = []
    ocr_pages = 0
    for page_no in page_numbers:
        page_text = "\n".join(texts.get(page_no, []))
        has_text = len(page_text.strip()) >= 5
        if has_text:
            ocr_state = "not-needed"
        elif ocr_enabled:
            ocr_state = "performed"
            ocr_pages += 1
        else:
            ocr_state = "required"
            ocr_pages += 1
            warnings.append("page %d has no text layer (OCR required)" % page_no)
        quality = 1.0 if has_text else 0.1
        pages.append({"page": page_no, "text": page_text, "ocr": ocr_state, "quality": quality})

    return pages, blocks, warnings, ocr_pages


def build_hybrid_chunks(doc, chunk_tokens):
    from docling.chunking import HybridChunker

    chunker = HybridChunker(max_tokens=chunk_tokens, merge_peers=True)
    chunks = []
    for chunk in chunker.chunk(dl_doc=doc):
        page_no = None
        headings = []
        try:
            for item in chunk.meta.doc_items:
                page_no = page_of(item) or page_no
            for heading in chunk.meta.headings or []:
                headings.append(getattr(heading, "text", str(heading)))
        except Exception:
            pass
        chunks.append(
            {
                "text": chunk.text,
                "page": page_no or 1,
                "headings": headings,
                "tokens": len(chunker.tokenizer.tokenize(chunk.text)) if hasattr(chunker, "tokenizer") else 0,
            }
        )
    return chunks


def main():
    try:
        request = json.loads(sys.stdin.read() or "{}")
    except Exception as error:
        return fail("VALIDATION", "invalid request JSON: %s" % error)

    path = request.get("path") or ""
    if not os.path.isfile(path):
        return fail("READ_FAILED", "PDF not found: %s" % path, path)

    try:
        from docling.datamodel.base_models import InputFormat
        from docling.datamodel.pipeline_options import PdfPipelineOptions
        from docling.document_converter import DocumentConverter, PdfFormatOption
        from docling_core.types.doc import DocItemLabel  # noqa: F401  (import check only)
    except Exception as error:
        return fail("DOCLING_UNAVAILABLE", "docling is not importable: %s" % error, traceback.format_exc())

    try:
        version = importlib.metadata.version("docling")
    except Exception:
        version = "unknown"

    ocr_enabled = bool(request.get("ocr", True))
    try:
        pipeline_options = PdfPipelineOptions()
        pipeline_options.do_ocr = ocr_enabled
        pipeline_options.do_table_structure = True
        converter = DocumentConverter(format_options={InputFormat.PDF: PdfFormatOption(pipeline_options=pipeline_options)})
        result = converter.convert(path)
        doc = result.document
        pages, blocks, warnings, ocr_pages = build_document(doc, version, ocr_enabled)
    except Exception as error:
        return fail("PARSE_FAILED", "Docling conversion failed: %s" % error, traceback.format_exc())

    hybrid_chunks = None
    if request.get("hybridChunking", True):
        try:
            hybrid_chunks = build_hybrid_chunks(doc, int(request.get("chunkTokens") or 700))
        except Exception as error:
            warnings.append("HybridChunker unavailable: %s" % error)

    document = {
        "parser": "docling",
        "parserVersion": "docling/%s" % version,
        "fileName": request.get("fileName") or os.path.basename(path),
        "pages": pages,
        "blocks": blocks,
        "warnings": warnings,
        "ocrPages": ocr_pages,
    }
    emit({"ok": True, "version": version, "document": document, "hybridChunks": hybrid_chunks})
    return 0


if __name__ == "__main__":
    sys.exit(main())
