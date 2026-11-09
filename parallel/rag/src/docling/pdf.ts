/**
 * Small, dependency-free PDF parser used when Docling is not installed.
 *
 * Scope: ordinary PDF 1.x files with a cross-reference table, direct page tree
 * dictionaries, and content streams that are either uncompressed or use
 * FlateDecode/ASCII85Decode. It resolves indirect Resources/Font dictionaries,
 * reads ToUnicode CMaps (single- and double-byte codes) and reconstructs the
 * reading order from text matrices. It deliberately does not implement object
 * streams, encryption or font glyph programs; those files are expected to go
 * through the fixed Docling worker instead.
 */
import { inflateSync } from 'node:zlib'
import type { BlockInfo, PageInfo, ParsedDocument } from '../types.ts'
import { RagError } from '../types.ts'

const WS = new Set(['\u0000', '\t', '\n', '\r', '\f', ' '])

class Cursor {
  text: string
  pos: number

  constructor(text: string, pos = 0) {
    this.text = text
    this.pos = pos
  }

  eof(): boolean {
    return this.pos >= this.text.length
  }

  skip(): void {
    while (!this.eof()) {
      const ch = this.text[this.pos]
      if (WS.has(ch)) {
        this.pos += 1
        continue
      }
      if (ch === '%') {
        while (!this.eof() && this.text[this.pos] !== '\n') this.pos += 1
        continue
      }
      break
    }
  }

  peek(): string {
    return this.text[this.pos] ?? ''
  }

  startsWith(value: string): boolean {
    return this.text.startsWith(value, this.pos)
  }

  take(value: string): boolean {
    if (!this.startsWith(value)) return false
    this.pos += value.length
    return true
  }

  number(): number | null {
    const match = /^[+-]?(?:\d+\.?\d*|\.\d+)/.exec(this.text.slice(this.pos))
    if (match === null) return null
    this.pos += match[0].length
    const value = Number.parseFloat(match[0])
    return Number.isFinite(value) ? value : null
  }

  name(): string | null {
    if (this.peek() !== '/') return null
    this.pos += 1
    let value = ''
    while (!this.eof()) {
      const ch = this.text[this.pos]
      if (WS.has(ch) || '/[]<>(){}%'.includes(ch)) break
      if (ch === '#' && /^[0-9a-fA-F]{2}$/.test(this.text.slice(this.pos + 1, this.pos + 3))) {
        value += String.fromCharCode(Number.parseInt(this.text.slice(this.pos + 1, this.pos + 3), 16))
        this.pos += 3
        continue
      }
      value += ch
      this.pos += 1
    }
    return value
  }

  literalString(): string | null {
    if (this.peek() !== '(') return null
    this.pos += 1
    let out = ''
    let depth = 1
    while (!this.eof()) {
      const ch = this.text[this.pos]
      this.pos += 1
      if (ch === '\\') {
        const next = this.text[this.pos]
        this.pos += 1
        if (next === undefined) break
        const simple: Record<string, string> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', '(': '(', ')': ')', '\\': '\\' }
        if (next in simple) {
          out += simple[next]
          continue
        }
        if (next === '\n' || next === '\r') continue
        if (/[0-7]/.test(next)) {
          let octal = next
          while (octal.length < 3 && /[0-7]/.test(this.text[this.pos] ?? '')) {
            octal += this.text[this.pos]
            this.pos += 1
          }
          out += String.fromCharCode(Number.parseInt(octal, 8))
          continue
        }
        out += next
        continue
      }
      if (ch === '(') {
        depth += 1
        out += ch
        continue
      }
      if (ch === ')') {
        depth -= 1
        if (depth === 0) break
        out += ch
        continue
      }
      out += ch
    }
    return out
  }

  hexString(): string | null {
    if (this.peek() !== '<' || this.startsWith('<<')) return null
    this.pos += 1
    let hex = ''
    while (!this.eof() && this.text[this.pos] !== '>') {
      const ch = this.text[this.pos]
      if (/[0-9a-fA-F]/.test(ch)) hex += ch
      this.pos += 1
    }
    this.pos += 1
    if (hex.length % 2 === 1) hex += '0'
    let out = ''
    for (let i = 0; i < hex.length; i += 2) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 2), 16))
    return out
  }
}

export type PdfRef = { kind: 'ref'; num: number }
export type PdfName = { kind: 'name'; value: string }
export type PdfValue = number | string | boolean | null | PdfRef | PdfName | PdfValue[] | PdfDict
export interface PdfDict {
  [key: string]: PdfValue
}
export interface PdfStream {
  dict: PdfDict
  raw: Buffer
}
export type PdfObject = PdfValue | PdfStream

function isRef(value: unknown): value is PdfRef {
  return typeof value === 'object' && value !== null && (value as PdfRef).kind === 'ref'
}
function isName(value: unknown): value is PdfName {
  return typeof value === 'object' && value !== null && (value as PdfName).kind === 'name'
}
function isDict(value: unknown): value is PdfDict {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !isRef(value) && !isName(value)
}
function isStream(value: unknown): value is PdfStream {
  return typeof value === 'object' && value !== null && 'dict' in value && 'raw' in value
}

function parseValue(cursor: Cursor): PdfValue {
  cursor.skip()
  if (cursor.startsWith('<<')) {
    cursor.take('<<')
    const dict: PdfDict = {}
    for (;;) {
      cursor.skip()
      if (cursor.take('>>')) break
      if (cursor.eof()) break
      const key = cursor.name()
      if (key === null) {
        cursor.pos += 1
        continue
      }
      dict[key] = parseValue(cursor)
    }
    return dict
  }
  if (cursor.peek() === '[') {
    cursor.pos += 1
    const array: PdfValue[] = []
    for (;;) {
      cursor.skip()
      if (cursor.take(']')) break
      if (cursor.eof()) break
      array.push(parseValue(cursor))
    }
    return array
  }
  if (cursor.peek() === '(') return cursor.literalString() ?? ''
  if (cursor.peek() === '<') return cursor.hexString() ?? ''
  if (cursor.peek() === '/') return { kind: 'name', value: cursor.name() ?? '' }
  if (cursor.startsWith('true')) {
    cursor.take('true')
    return true
  }
  if (cursor.startsWith('false')) {
    cursor.take('false')
    return false
  }
  if (cursor.startsWith('null')) {
    cursor.take('null')
    return null
  }
  const first = cursor.number()
  if (first !== null) {
    const save = cursor.pos
    cursor.skip()
    const second = cursor.number()
    if (second !== null) {
      cursor.skip()
      if (cursor.peek() === 'R' && !/[A-Za-z0-9]/.test(cursor.text[cursor.pos + 1] ?? ' ')) {
        cursor.pos += 1
        return { kind: 'ref', num: Math.trunc(first) }
      }
    }
    cursor.pos = save
    return first
  }
  const word = /^[A-Za-z*'"]+/.exec(cursor.text.slice(cursor.pos))
  if (word !== null) {
    cursor.pos += word[0].length
    return word[0]
  }
  cursor.pos += 1
  return null
}

function readObjects(text: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>()
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text)) !== null) {
    const num = Number.parseInt(match[1], 10)
    const cursor = new Cursor(text, pattern.lastIndex)
    let value: PdfValue
    try {
      value = parseValue(cursor)
    } catch {
      continue
    }
    cursor.skip()
    if (cursor.startsWith('stream')) {
      cursor.take('stream')
      if (cursor.startsWith('\r\n')) cursor.pos += 2
      else if (cursor.peek() === '\n' || cursor.peek() === '\r') cursor.pos += 1
      let length = -1
      if (isDict(value) && typeof value.Length === 'number') length = Math.trunc(value.Length)
      let end = -1
      if (length >= 0 && cursor.pos + length <= text.length) {
        const candidate = text.slice(cursor.pos, cursor.pos + length)
        const after = text.slice(cursor.pos + length, cursor.pos + length + 20)
        if (/^\s*endstream/.test(after)) end = cursor.pos + length
        else end = -1
      }
      if (end < 0) end = text.indexOf('endstream', cursor.pos)
      if (end < 0) end = text.length
      const rawText = text.slice(cursor.pos, end)
      objects.set(num, { dict: isDict(value) ? value : {}, raw: Buffer.from(rawText, 'latin1') })
      pattern.lastIndex = end + 9
    } else {
      objects.set(num, value)
      pattern.lastIndex = cursor.pos
    }
  }
  return objects
}

function ascii85Decode(input: Buffer): Buffer {
  const text = input.toString('latin1').replace(/\s+/g, '')
  const out: number[] = []
  let group: number[] = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const code = ch.charCodeAt(0)
    if (code === 0x7e) break
    if (code === 0x7a && group.length === 0) {
      out.push(0, 0, 0, 0)
      continue
    }
    group.push(code - 33)
    if (group.length === 5) {
      let value = 0
      for (const digit of group) value = value * 85 + digit
      out.push((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff)
      group = []
    }
  }
  if (group.length > 1) {
    const missing = 5 - group.length
    for (let i = 0; i < missing; i += 1) group.push(84)
    let value = 0
    for (const digit of group) value = value * 85 + digit
    const bytes = [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]
    out.push(...bytes.slice(0, 4 - missing))
  }
  return Buffer.from(out)
}

function decodeStream(stream: PdfStream): Buffer {
  let buffer = stream.raw
  const filterValue = stream.dict.Filter
  const filters: string[] = []
  if (isName(filterValue)) filters.push(filterValue.value)
  else if (Array.isArray(filterValue)) {
    for (const item of filterValue) if (isName(item)) filters.push(item.value)
  }
  for (const filter of filters) {
    if (filter === 'FlateDecode' || filter === 'Fl') buffer = inflateSync(buffer)
    else if (filter === 'ASCII85Decode' || filter === 'A85') buffer = ascii85Decode(buffer)
    else if (filter === 'ASCIIHexDecode' || filter === 'AHx') {
      const hex = buffer.toString('latin1').replace(/>.*$/s, '').replace(/[^0-9a-fA-F]/g, '')
      const padded = hex.length % 2 === 0 ? hex : `${hex}0`
      const bytes: number[] = []
      for (let i = 0; i < padded.length; i += 2) bytes.push(Number.parseInt(padded.slice(i, i + 2), 16))
      buffer = Buffer.from(bytes)
    } else throw new Error(`unsupported PDF filter ${filter}`)
  }
  return buffer
}

interface CMap {
  codeLength: number
  map: Map<string, string>
}

function decodeUtf16Hex(hex: string): string {
  let out = ''
  for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16))
  return out
}

function parseCMap(text: string): CMap {
  const map = new Map<string, string>()
  let codeLength = 1
  const range = /begincodespacerange\s*<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/.exec(text)
  if (range !== null) codeLength = Math.max(1, Math.ceil(Math.min(range[1].length, range[2].length) / 2))
  const bfchar = /beginbfchar([\s\S]*?)endbfchar/g
  let block: RegExpExecArray | null
  while ((block = bfchar.exec(text)) !== null) {
    const pairs = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g
    let pair: RegExpExecArray | null
    while ((pair = pairs.exec(block[1])) !== null) {
      const key = pair[1].toLowerCase().padStart(codeLength * 2, '0')
      map.set(key, decodeUtf16Hex(pair[2]))
    }
  }
  const bfrange = /beginbfrange([\s\S]*?)endbfrange/g
  while ((block = bfrange.exec(text)) !== null) {
    const triples = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g
    let triple: RegExpExecArray | null
    while ((triple = triples.exec(block[1])) !== null) {
      const start = Number.parseInt(triple[1], 16)
      const end = Number.parseInt(triple[2], 16)
      if (end - start > 65535) continue
      if (triple[3] !== undefined) {
        const base = Number.parseInt(triple[3], 16)
        for (let code = start; code <= end; code += 1) {
          const key = code.toString(16).padStart(codeLength * 2, '0')
          map.set(key, String.fromCharCode(base + (code - start)))
        }
      } else if (triple[4] !== undefined) {
        const items = [...triple[4].matchAll(/<([0-9a-fA-F]+)>/g)].map((item) => item[1])
        items.forEach((item, index) => {
          const key = (start + index).toString(16).padStart(codeLength * 2, '0')
          map.set(key, decodeUtf16Hex(item))
        })
      }
    }
  }
  return { codeLength, map }
}

interface FontDecoder {
  codeLength: number
  map: Map<string, string> | null
  decode(bytes: string): string
}

function buildFontDecoder(objects: Map<number, PdfObject>, fontDict: PdfDict | null): FontDecoder {
  let codeLength = 1
  let map: Map<string, string> | null = null
  const toUnicode = fontDict?.ToUnicode
  if (isRef(toUnicode)) {
    const stream = objects.get(toUnicode.num)
    if (isStream(stream)) {
      try {
        const cmap = parseCMap(decodeStream(stream).toString('latin1'))
        codeLength = cmap.codeLength
        map = cmap.map
      } catch {
        map = null
      }
    }
  } else if (isName(fontDict?.Subtype) && fontDict.Subtype.value === 'Type0') {
    codeLength = 2
  }
  return {
    codeLength,
    map,
    decode(bytes: string): string {
      let out = ''
      for (let i = 0; i + codeLength <= bytes.length; i += codeLength) {
        const hex = Buffer.from(bytes.slice(i, i + codeLength), 'latin1').toString('hex')
        const mapped = map?.get(hex)
        if (mapped !== undefined) out += mapped
        else if (map === null) out += bytes.slice(i, i + codeLength)
      }
      return out
    }
  }
}

type Matrix = [number, number, number, number, number, number]
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0]

function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5]
  ]
}

interface TextRun {
  x: number
  y: number
  size: number
  text: string
}

interface PageContent {
  runs: TextRun[]
  hasImage: boolean
}

function tokenizeContent(text: string): Array<{ kind: 'num' | 'str' | 'name' | 'op' | 'array'; value: number | string | unknown[] }> {
  const tokens: Array<{ kind: 'num' | 'str' | 'name' | 'op' | 'array'; value: number | string | unknown[] }> = []
  const cursor = new Cursor(text)
  while (!cursor.eof()) {
    cursor.skip()
    if (cursor.eof()) break
    const ch = cursor.peek()
    if (ch === '(') {
      const value = cursor.literalString()
      if (value !== null) tokens.push({ kind: 'str', value })
      continue
    }
    if (ch === '<' && !cursor.startsWith('<<')) {
      const value = cursor.hexString()
      if (value !== null) tokens.push({ kind: 'str', value })
      continue
    }
    if (ch === '[') {
      const array: unknown[] = []
      cursor.pos += 1
      for (;;) {
        cursor.skip()
        if (cursor.take(']')) break
        if (cursor.eof()) break
        const inner = tokenizeOne(cursor)
        if (inner !== null) array.push(inner.value)
      }
      tokens.push({ kind: 'array', value: array })
      continue
    }
    const one = tokenizeOne(cursor)
    if (one !== null) tokens.push(one)
    else if (!cursor.eof()) cursor.pos += 1
  }
  return tokens
}

function tokenizeOne(cursor: Cursor): { kind: 'num' | 'str' | 'name' | 'op'; value: number | string } | null {
  cursor.skip()
  if (cursor.eof()) return null
  const ch = cursor.peek()
  if (ch === '(') {
    const value = cursor.literalString()
    return value === null ? null : { kind: 'str', value }
  }
  if (ch === '<' && !cursor.startsWith('<<')) {
    const value = cursor.hexString()
    return value === null ? null : { kind: 'str', value }
  }
  if (ch === '/') {
    const value = cursor.name()
    return value === null ? null : { kind: 'name', value }
  }
  const num = cursor.number()
  if (num !== null) return { kind: 'num', value: num }
  const word = /^[A-Za-z*'"]+/.exec(cursor.text.slice(cursor.pos))
  if (word !== null) {
    cursor.pos += word[0].length
    return { kind: 'op', value: word[0] }
  }
  cursor.pos += 1
  return null
}

function interpretContent(text: string, fonts: Map<string, FontDecoder>): PageContent {
  const runs: TextRun[] = []
  let hasImage = false
  const stack: Array<{ ctm: Matrix; tm: Matrix; leading: number; font: string; size: number }> = []
  const state = { ctm: IDENTITY as Matrix, tm: IDENTITY as Matrix, leading: 0, font: '', size: 12 }
  let operands: Array<number | string | unknown[]> = []

  const show = (value: string): void => {
    const decoder = fonts.get(state.font)
    const decoded = decoder === undefined ? value : decoder.decode(value)
    if (decoded.length === 0) return
    const matrix = multiply(state.tm, state.ctm)
    runs.push({ x: matrix[4], y: matrix[5], size: state.size, text: decoded })
  }

  for (const token of tokenizeContent(text)) {
    if (token.kind !== 'op') {
      operands.push(token.value)
      continue
    }
    const op = token.value as string
    if (op === 'q') {
      stack.push({ ...state, ctm: [...state.ctm] as Matrix, tm: [...state.tm] as Matrix })
    } else if (op === 'Q') {
      const previous = stack.pop()
      if (previous !== undefined) Object.assign(state, previous)
    } else if (op === 'cm' && operands.length >= 6) {
      const values = operands.slice(-6).map(Number) as Matrix
      state.ctm = multiply(values, state.ctm)
    } else if (op === 'BT') {
      state.tm = IDENTITY
    } else if (op === 'Tm' && operands.length >= 6) {
      state.tm = operands.slice(-6).map(Number) as Matrix
    } else if ((op === 'Td' || op === 'TD') && operands.length >= 2) {
      const [tx, ty] = operands.slice(-2).map(Number)
      state.tm = multiply([1, 0, 0, 1, tx, ty], state.tm)
      if (op === 'TD') state.leading = -ty
    } else if (op === 'T*') {
      state.tm = multiply([1, 0, 0, 1, 0, -state.leading], state.tm)
    } else if (op === 'TL' && operands.length >= 1) {
      state.leading = Number(operands[operands.length - 1])
    } else if (op === 'Tf' && operands.length >= 2) {
      state.font = String(operands[operands.length - 2])
      state.size = Number(operands[operands.length - 1])
    } else if (op === 'Tj' && operands.length >= 1) {
      const value = operands[operands.length - 1]
      if (typeof value === 'string') show(value)
    } else if (op === 'TJ' && operands.length >= 1) {
      const value = operands[operands.length - 1]
      if (Array.isArray(value)) {
        for (const item of value) if (typeof item === 'string') show(item)
      }
    } else if (op === "'" && operands.length >= 1) {
      state.tm = multiply([1, 0, 0, 1, 0, -state.leading], state.tm)
      const value = operands[operands.length - 1]
      if (typeof value === 'string') show(value)
    } else if (op === 'Do') {
      hasImage = true
    } else if (op === 'BI') {
      hasImage = true
    }
    operands = []
  }
  return { runs, hasImage }
}

function runsToText(runs: TextRun[]): string {
  if (runs.length === 0) return ''
  const sorted = [...runs].sort((a, b) => b.y - a.y || a.x - b.x)
  const lines: Array<{ y: number; size: number; runs: TextRun[] }> = []
  for (const run of sorted) {
    const tolerance = Math.max(6, run.size * 0.8)
    const line = lines.find((candidate) => Math.abs(candidate.y - run.y) <= tolerance)
    if (line === undefined) lines.push({ y: run.y, size: run.size, runs: [run] })
    else {
      line.runs.push(run)
      line.y = (line.y * (line.runs.length - 1) + run.y) / line.runs.length
      line.size = Math.max(line.size, run.size)
    }
  }
  lines.sort((a, b) => b.y - a.y)
  const out: string[] = []
  for (const line of lines) {
    line.runs.sort((a, b) => a.x - b.x)
    let text = ''
    let lastEnd = Number.NaN
    for (const run of line.runs) {
      const clean = run.text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
      if (clean.length === 0) continue
      if (Number.isFinite(lastEnd) && run.x - lastEnd > Math.max(1.2, run.size * 0.25)) text += ' '
      text += clean
      lastEnd = run.x + clean.length * run.size * 0.5
    }
    const trimmed = text.replace(/\s+/g, ' ').trim()
    if (trimmed.length > 0) out.push(trimmed)
  }
  return out.join('\n')
}

export function parsePdfBuffer(buffer: Buffer, fileName: string): ParsedDocument {
  const text = buffer.toString('latin1')
  if (!text.startsWith('%PDF-')) {
    throw new RagError('PARSE_FAILED', `${fileName}: not a PDF (missing %PDF header)`)
  }
  const objects = readObjects(text)
  const resolve = (value: PdfValue | undefined): PdfValue | undefined => {
    if (isRef(value)) return objects.get(value.num) as PdfValue | undefined
    return value
  }
  const dictOf = (value: PdfValue | undefined): PdfDict | null => {
    const resolved = resolve(value)
    if (isStream(resolved)) return resolved.dict
    return isDict(resolved) ? resolved : null
  }

  let catalog: PdfDict | null = null
  for (const object of objects.values()) {
    const dict = isStream(object) ? object.dict : isDict(object) ? object : null
    if (dict !== null && isName(dict.Type) && dict.Type.value === 'Catalog') {
      catalog = dict
      break
    }
  }

  const pages: Array<{ dict: PdfDict; resources: PdfDict | null }> = []
  const walk = (nodeValue: PdfValue | undefined, inherited: PdfDict | null): void => {
    const node = dictOf(nodeValue)
    if (node === null) return
    const resources = dictOf(node.Resources) ?? inherited
    const type = isName(node.Type) ? node.Type.value : ''
    if (type === 'Pages' || Array.isArray(node.Kids)) {
      const kids = resolve(node.Kids)
      if (Array.isArray(kids)) for (const kid of kids) walk(kid, resources)
      return
    }
    pages.push({ dict: node, resources })
  }
  if (catalog !== null) walk(catalog.Pages, null)
  if (pages.length === 0) {
    for (const object of objects.values()) {
      const dict = isStream(object) ? object.dict : isDict(object) ? object : null
      if (dict === null) continue
      if (isName(dict.Type) && dict.Type.value === 'Page') pages.push({ dict, resources: dictOf(dict.Resources) })
    }
  }
  if (pages.length === 0) throw new RagError('PARSE_FAILED', `${fileName}: no pages found`)

  const pageInfos: PageInfo[] = []
  const blocks: BlockInfo[] = []
  const warnings: string[] = []
  let globalBlock = 0

  pages.forEach((page, index) => {
    const pageNumber = index + 1
    const fontDict = page.resources === null ? null : dictOf(page.resources.Font)
    const fonts = new Map<string, FontDecoder>()
    if (fontDict !== null) {
      for (const [name, value] of Object.entries(fontDict)) {
        fonts.set(name, buildFontDecoder(objects, dictOf(value)))
      }
    }
    const contentsValue = resolve(page.dict.Contents)
    const contentRefs = Array.isArray(contentsValue) ? contentsValue : [page.dict.Contents]
    const chunks: string[] = []
    for (const contentRef of contentRefs) {
      const resolved = contentRef !== undefined ? objects.get(isRef(contentRef) ? contentRef.num : -1) : undefined
      if (!isStream(resolved)) continue
      try {
        chunks.push(decodeStream(resolved).toString('latin1'))
      } catch (error) {
        warnings.push(`page ${pageNumber}: content stream skipped (${error instanceof Error ? error.message : String(error)})`)
      }
    }
    const interpreted = interpretContent(chunks.join('\n'), fonts)
    const pageText = runsToText(interpreted.runs)
    const ocrRequired = pageText.trim().length < 5 && interpreted.hasImage && chunks.length > 0
    const quality = pageText.length >= 20 ? 1 : pageText.length > 0 ? 0.5 : interpreted.hasImage ? 0.1 : 0.2
    pageInfos.push({ page: pageNumber, text: pageText, ocr: ocrRequired ? 'required' : 'not-needed', quality })

    let offset = 0
    for (const line of pageText.split('\n')) {
      if (line.length === 0) continue
      const isHeading = /^\d+\.(\d+\.)*\s/.test(line) || (line.length <= 32 && /^(Specification|规格书|手册|Handbook)$/i.test(line))
      blocks.push({
        id: `b-${pageNumber}-${globalBlock++}`,
        page: pageNumber,
        kind: isHeading ? 'heading' : 'paragraph',
        text: line,
        charStart: offset,
        charEnd: offset + line.length
      })
      offset += line.length + 1
    }
  })

  const ocrPages = pageInfos.filter((page) => page.ocr === 'required').map((page) => page.page)
  if (ocrPages.length > 0) warnings.push(`pages without a text layer (OCR required): ${ocrPages.join(', ')}`)

  return {
    parser: 'pdf-fallback',
    parserVersion: 'pdf-fallback/1',
    fileName,
    pages: pageInfos,
    blocks,
    warnings
  }
}
