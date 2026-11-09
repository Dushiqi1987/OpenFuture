#!/usr/bin/env python
"""Generate deterministic synthetic CN/EN fixtures for the parallel RAG line.

Outputs (all inside parallel/rag/fixtures):
  spec-cn-en.pdf   electronic 3-page PDF, mixed Chinese/English, a table that
                   splits across pages and repeats its header
  scan-cn-en.pdf   image-only 2-page PDF (no text layer, OCR required)
  handbook-cn-en.md  markdown source with overlapping facts and one decoy
  queries.json     acceptance questions with gold page/phrase expectations

The PDFs use reportlab's invariant mode (fixed timestamps and object ids) plus
pageCompression=0, so the bytes are deterministic and the fallback parser can
read the literal text operators.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont
from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.pdfgen import canvas
from reportlab.platypus import LongTable, PageBreak, Paragraph, SimpleDocTemplate, Spacer, TableStyle

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "fixtures"
FONT = Path("C:/Windows/Fonts/simhei.ttf")

PAGE_W, PAGE_H = A4
FOOTER_Y = 18 * mm


def register_fonts() -> None:
    pdfmetrics.registerFont(TTFont("SimHei", str(FONT)))
    pdfmetrics.registerFontFamily("SimHei", normal="SimHei", bold="SimHei", italic="SimHei", boldItalic="SimHei")


def styles() -> dict[str, ParagraphStyle]:
    base = getSampleStyleSheet()
    return {
        "title": ParagraphStyle("Title", parent=base["Title"], fontName="SimHei", fontSize=20, leading=26),
        "h2": ParagraphStyle("H2", parent=base["Heading2"], fontName="SimHei", fontSize=14, leading=20, spaceBefore=6),
        "body": ParagraphStyle("Body", parent=base["BodyText"], fontName="SimHei", fontSize=10.5, leading=16),
        "cell": ParagraphStyle("Cell", parent=base["BodyText"], fontName="SimHei", fontSize=8.5, leading=11),
        "small": ParagraphStyle("Small", parent=base["BodyText"], fontName="SimHei", fontSize=8, textColor=colors.grey),
    }


def footer(canv: canvas.Canvas, doc, label: str) -> None:
    canv.saveState()
    canv.setFont("SimHei", 8)
    canv.setFillColor(colors.grey)
    canv.drawString(20 * mm, FOOTER_Y, label)
    canv.drawRightString(PAGE_W - 20 * mm, FOOTER_Y, f"第 {doc.page} 页 / Page {doc.page}")
    canv.restoreState()


def table_rows() -> list[list[str]]:
    return [
        ["型号 / Model", "最大吞吐 / Throughput", "典型功耗 / Power", "待机功耗 / Standby", "备注 / Note"],
        ["OF-2200", "800 页/分钟", "240 W", "8 W", "标准配置 / standard"],
        ["OF-2200 Pro", "1200 页/分钟", "320 W", "6 W", "双扫描头 / dual head"],
        ["OF-2200 Lite", "600 页/分钟", "180 W", "5 W", "入门配置 / entry"],
        ["OF-2200 X", "1600 页/分钟", "410 W", "9 W", "高负载 / high load"],
        ["OF-2200 Pro+", "1400 页/分钟", "360 W", "6 W", "扩展 / extended"],
        ["OF-2200 Duo", "1000 页/分钟", "300 W", "7 W", "双机热备 / hot standby"],
        ["OF-2200 Air", "700 页/分钟", "210 W", "4 W", "低噪音 / low noise"],
        ["OF-2200 Rack", "1300 页/分钟", "340 W", "7 W", "机架式 / rack"],
        ["OF-2200 Edge", "500 页/分钟", "150 W", "3 W", "边缘部署 / edge"],
        ["OF-2200 Max", "1800 页/分钟", "450 W", "10 W", "旗舰 / flagship"],
        ["OF-2200 Pro", "1200 页/分钟", "320 W", "6 W", "跨页续行 / continued"],
        ["OF-2200 X", "1600 页/分钟", "410 W", "9 W", "跨页续行 / continued"],
        ["OF-2200 Lite", "600 页/分钟", "180 W", "5 W", "跨页续行 / continued"],
    ]


def build_spec() -> None:
    s = styles()
    doc = SimpleDocTemplate(
        str(OUT / "spec-cn-en.pdf"),
        pagesize=A4,
        leftMargin=20 * mm,
        rightMargin=20 * mm,
        topMargin=20 * mm,
        bottomMargin=26 * mm,
        title="OpenFuture Memory Gateway Specification",
        author="OpenFuture synthetic fixture",
        invariant=1,
        pageCompression=0,
    )
    story: list = []
    story.append(Paragraph("OpenFuture 记忆网关规格书 / Memory Gateway Specification", s["title"]))
    story.append(Paragraph("版本 v2.3 · 合成资料，仅用于并行 RAG 验收 / synthetic, acceptance only", s["small"]))
    story.append(Spacer(1, 8 * mm))
    story.append(Paragraph("1. 型号与定位 / Models", s["h2"]))
    for line in [
        "OF-2200 Pro：面向大型归档场景，最大吞吐量 1200 页/分钟，典型功耗 320 W。",
        "OF-2200 Pro targets large archives with a maximum throughput of 1200 pages per minute and 320 W typical power.",
        "OF-2200 Lite：入门型号，最大吞吐量 600 页/分钟，待机功耗 5 W。",
        "OF-2200 X：高负载型号，最大吞吐量 1600 页/分钟，典型功耗 410 W。",
    ]:
        story.append(Paragraph(line, s["body"]))
        story.append(Spacer(1, 2 * mm))
    story.append(Paragraph("2. 部署与升级 / Deployment", s["h2"]))
    for line in [
        "升级前请先备份配置。固件升级失败时系统重试间隔为 30 秒 (retry interval 30 seconds)，直到链路恢复。",
        "回滚窗口为 15 分钟；超过窗口需要重新导入配置。",
        "整机保修 36 个月 / warranty 36 months from delivery。",
    ]:
        story.append(Paragraph(line, s["body"]))
        story.append(Spacer(1, 2 * mm))
    story.append(PageBreak())

    story.append(Paragraph("3. 吞吐与功耗对比 / Throughput and power comparison", s["h2"]))
    story.append(Paragraph(
        "下表列出各型号的吞吐与功耗。表格跨页时重复表头，便于人工核对。"
        "The table below repeats its header when it continues on the next page.",
        s["body"],
    ))
    story.append(Spacer(1, 4 * mm))
    grid = [[Paragraph(cell, s["cell"]) for cell in row] for row in table_rows()]
    table = LongTable(
        grid,
        colWidths=[34 * mm, 40 * mm, 32 * mm, 32 * mm, 32 * mm],
        rowHeights=[18 * mm for _ in grid],
        repeatRows=1,
    )
    table.setStyle(TableStyle([
        ("GRID", (0, 0), (-1, -1), 0.4, colors.black),
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#d9e2f3")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("TOPPADDING", (0, 0), (-1, -1), 4),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 4),
    ]))
    story.append(table)
    story.append(Spacer(1, 6 * mm))
    story.append(Paragraph("4. 保修与支持 / Warranty and support", s["h2"]))
    for line in [
        "整机保修 36 个月 (36 months)，备件供应周期 7 年。",
        "技术支持升级路径：一线支持 → 二线支持 → 研发。",
        "固件升级重试间隔 30 秒 (retry interval 30 seconds)；超时后记录错误码 E-RETRY-30。",
    ]:
        story.append(Paragraph(line, s["body"]))
        story.append(Spacer(1, 2 * mm))

    doc.build(story, onFirstPage=lambda c, d: footer(c, d, "OpenFuture 合成规格书"), onLaterPages=lambda c, d: footer(c, d, "OpenFuture 合成规格书"))


def render_scan_page(lines: list[str], path: Path) -> None:
    width, height = 1240, 1754
    image = Image.new("RGB", (width, height), "white")
    draw = ImageDraw.Draw(image)
    font = ImageFont.truetype(str(FONT), 40)
    y = 180
    for line in lines:
        draw.text((120, y), line, fill="black", font=font)
        y += 90
    image.save(path, "JPEG", quality=88, optimize=False)


def build_scan() -> None:
    tmp = OUT / ".scan-page1.jpg"
    tmp2 = OUT / ".scan-page2.jpg"
    render_scan_page([
        "扫描件 / Scanned copy — 固件升级步骤",
        "步骤 1：升级前先备份配置 (back up configuration)。",
        "步骤 2：校验固件签名，确认来源可信。",
        "适用型号：OF-2200 Pro 固件 v2.3.1。",
    ], tmp)
    render_scan_page([
        "步骤 3：重启设备并确认版本号为 v2.3.1。",
        "步骤 4：若升级失败，等待 30 秒后重试。",
        "注意：扫描件没有文本层，需要 OCR。",
    ], tmp2)
    c = canvas.Canvas(str(OUT / "scan-cn-en.pdf"), pagesize=A4, invariant=1, pageCompression=0)
    for image_path in (tmp, tmp2):
        c.drawImage(str(image_path), 0, 0, width=PAGE_W, height=PAGE_H)
        c.showPage()
    c.save()
    tmp.unlink(missing_ok=True)
    tmp2.unlink(missing_ok=True)


HANDBOOK = """# OpenFuture 运维手册 / Operations handbook

## 1. 升级流程 / Upgrade flow

升级前必须备份配置。固件升级采用 30 秒重试间隔 (retry interval 30 seconds)，
失败三次后停止并保留旧版本。回滚窗口为 15 分钟。

## 2. 保修 / Warranty

整机保修 36 个月 (36 months from delivery)。人为损坏不在保修范围内。
备件供应周期为 7 年。

## 3. 型号差异 / Model differences

OF-2200 Lite 待机功耗 5 W，适合边缘部署。OF-2200 Pro 最大吞吐量 1200 页/分钟。
OF-2200 X 典型功耗 410 W，适合高负载批处理。

## 4. 升级路径 / Escalation

一线支持无法解决时升级到二线支持；二线支持仍无法定位时升级到研发。
"""


QUERIES = [
    {
        "id": "q-pro-warranty",
        "query": "OF-2200 Pro 的保修期是多久？",
        "kind": "lexical",
        "gold": {"sourceFile": "spec-cn-en.pdf", "page": 3, "phrase": "保修 36 个月"},
    },
    {
        "id": "q-pro-throughput",
        "query": "OF-2200 Pro 最大吞吐量是多少",
        "kind": "lexical",
        "gold": {"sourceFile": "spec-cn-en.pdf", "page": 2, "phrase": "1200 页/分钟"},
    },
    {
        "id": "q-retry-en",
        "query": "retry interval after a firmware upgrade failure",
        "kind": "semantic",
        "gold": {"sourceFile": "spec-cn-en.pdf", "page": 3, "phrase": "retry interval 30 seconds"},
    },
    {
        "id": "q-lite-standby",
        "query": "OF-2200 Lite 待机功耗",
        "kind": "multihop",
        "gold": {"sourceFile": "spec-cn-en.pdf", "page": 2, "phrase": "5 W"},
    },
    {
        "id": "q-x-power",
        "query": "How much power does the OF-2200 X use?",
        "kind": "semantic",
        "gold": {"sourceFile": "spec-cn-en.pdf", "page": 2, "phrase": "410 W"},
    },
    {
        "id": "q-backup-rollback",
        "query": "升级失败后的回滚窗口和重试间隔",
        "kind": "multihop",
        "gold": {"sourceFile": "spec-cn-en.pdf", "page": 1, "phrase": "15 分钟"},
    },
    {
        "id": "q-handbook-warranty",
        "query": "保修期内备件供应周期",
        "kind": "lexical",
        "gold": {"sourceFile": "handbook-cn-en.md", "page": 1, "phrase": "备件供应周期为 7 年"},
    },
    {
        "id": "q-scan-upgrade",
        "query": "扫描件中的固件升级步骤",
        "kind": "scan",
        "gold": {"sourceFile": "scan-cn-en.pdf", "page": 1, "phrase": "备份配置"},
    },
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    register_fonts()
    build_spec()
    build_scan()
    (OUT / "handbook-cn-en.md").write_text(HANDBOOK, encoding="utf-8", newline="\n")
    queries = {"version": 1, "queries": QUERIES}
    (OUT / "queries.json").write_text(json.dumps(queries, ensure_ascii=False, indent=2) + "\n", encoding="utf-8", newline="\n")
    for name in ("spec-cn-en.pdf", "scan-cn-en.pdf", "handbook-cn-en.md", "queries.json"):
        size = (OUT / name).stat().st_size
        print(f"{name}\t{size}")


if __name__ == "__main__":
    main()
