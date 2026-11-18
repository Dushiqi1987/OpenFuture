import { Fragment } from 'react'
import type React from 'react'

// Local file paths the model prints (absolute Windows/POSIX, or workspace
// relative) and http(s) URLs. Kept conservative: a known extension is
// required for paths so ordinary prose with slashes does not turn blue.
const LINK_PATTERN =
  /(https?:\/\/[^\s<>"'`）)\]]+)|((?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)?(?:[\w.@~-]+[\\/])+[\w.@~-]+\.(?:x?html?|md|txt|json|jsonc|jsx?|tsx?|mjs|cjs|css|scss|svg|png|jpe?g|gif|webp|pdf|py|ps1|sh|log|ya?ml|toml|xml|csv))(?::\d+(?::\d+)?)?/g

export interface RichTextProps {
  text: string
  onOpen: (target: string) => void
  /** Extra class for link chips, e.g. `file-link-strong`. */
  linkClassName?: string
}

type InlineKind = 'code' | 'strong' | 'em' | 'link'

/**
 * Inline Markdown: `code`, **bold**, *italic* and the file/URL links that
 * RichText has always supported. The scanner always takes the earliest match
 * so nesting stays predictable (`**a `b` c**` highlights the code first).
 */
function renderInline(text: string, onOpen: (target: string) => void, linkClassName?: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let rest = text
  let key = 0
  while (rest.length > 0) {
    let best: { kind: InlineKind; match: RegExpExecArray } | null = null
    const code = /`([^`\n]+)`/.exec(rest)
    if (code) best = { kind: 'code', match: code }
    const strong = /\*\*([^*\n]+)\*\*/.exec(rest)
    if (strong && (!best || strong.index < best.match.index)) best = { kind: 'strong', match: strong }
    LINK_PATTERN.lastIndex = 0
    const link = LINK_PATTERN.exec(rest)
    if (link && (!best || link.index < best.match.index)) best = { kind: 'link', match: link }
    if (!best) best = null
    let em: RegExpExecArray | null = null
    const emMatch = /(^|[^*])\*([^*\n]+)\*/.exec(rest)
    if (emMatch) em = emMatch

    if (em && (!best || em.index < best.match.index)) best = { kind: 'em', match: em }

    if (!best) {
      nodes.push(rest)
      break
    }
    const { kind, match } = best
    // The italic pattern eats one char of context to avoid `**` matches.
    const lead = kind === 'em' ? (match[1] ?? '') : ''
    const start = match.index + lead.length
    if (start > 0) nodes.push(rest.slice(0, start))
    const value = match[0].slice(lead.length)
    if (kind === 'link') {
      const isUrl = value.startsWith('http')
      nodes.push(
        <button
          type="button"
          key={`l${key++}`}
          className={['inline-link', isUrl ? 'inline-link-url' : 'inline-link-path', linkClassName ?? '']
            .filter(Boolean)
            .join(' ')}
          title={isUrl ? `在内置浏览器中打开 ${value}` : `打开 ${value}`}
          onClick={() => onOpen(value)}
        >
          {value}
        </button>
      )
    } else if (kind === 'code') {
      nodes.push(
        <code className="md-inline-code" key={`c${key++}`}>
          {match[1] ?? ''}
        </code>
      )
    } else if (kind === 'strong') {
      nodes.push(<strong key={`s${key++}`}>{renderInline(match[1] ?? '', onOpen, linkClassName)}</strong>)
    } else {
      nodes.push(<em key={`e${key++}`}>{renderInline(match[2] ?? '', onOpen, linkClassName)}</em>)
    }
    rest = rest.slice(start + value.length)
  }
  return nodes
}

function splitRow(row: string): string[] {
  return row
    .replace(/^\s*\|/, '')
    .replace(/\|\s*$/, '')
    .split('|')
    .map((cell) => cell.trim())
}

const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}/

/**
 * Block Markdown for assistant answers: fenced code, GitHub-style tables,
 * headings, quotes, lists and paragraphs. Each line stays verbatim, so the
 * whitespace of the original answer is preserved while tables stop rendering
 * as raw pipes.
 */
export function RichText({ text, onOpen, linkClassName }: RichTextProps): React.JSX.Element {
  const lines = text.split('\n')
  const blocks: React.ReactNode[] = []
  let i = 0
  let key = 0

  while (i < lines.length) {
    const line = lines[i] ?? ''

    const fence = /^\s*```(\w*)\s*$/.exec(line)
    if (fence) {
      const body: string[] = []
      i += 1
      while (i < lines.length && !/^\s*```\s*$/.test(lines[i] ?? '')) body.push(lines[i++] ?? '')
      i += 1
      blocks.push(
        <pre className="md-code" key={`code${key++}`}>
          <code>{body.join('\n')}</code>
        </pre>
      )
      continue
    }

    if (line.includes('|') && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1] ?? '')) {
      const header = splitRow(line)
      i += 2
      const rows: string[][] = []
      while (i < lines.length && (lines[i] ?? '').includes('|') && (lines[i] ?? '').trim() !== '') {
        rows.push(splitRow(lines[i] ?? ''))
        i += 1
      }
      blocks.push(
        <table className="md-table" key={`table${key++}`}>
          <thead>
            <tr>
              {header.map((cell, index) => (
                <th key={index}>{renderInline(cell, onOpen, linkClassName)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, rowIndex) => (
              <tr key={rowIndex}>
                {row.map((cell, cellIndex) => (
                  <td key={cellIndex}>{renderInline(cell, onOpen, linkClassName)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )
      continue
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line)
    if (heading) {
      const level = (heading[1] ?? '#').length
      blocks.push(
        <div className={`md-h md-h${level}`} key={`h${key++}`}>
          {renderInline(heading[2] ?? '', onOpen, linkClassName)}
        </div>
      )
      i += 1
      continue
    }

    if (/^>\s?/.test(line)) {
      blocks.push(
        <div className="md-quote" key={`q${key++}`}>
          {renderInline(line.replace(/^>\s?/, ''), onOpen, linkClassName)}
        </div>
      )
      i += 1
      continue
    }

    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const ordered = /^\s*\d+\./.test(line)
      const items: React.ReactNode[] = []
      while (i < lines.length && /^\s*([-*+]|\d+\.)\s+/.test(lines[i] ?? '')) {
        const item = (lines[i] ?? '').replace(/^\s*([-*+]|\d+\.)\s+/, '')
        items.push(<li key={`li${i}`}>{renderInline(item, onOpen, linkClassName)}</li>)
        i += 1
      }
      blocks.push(
        ordered ? (
          <ol className="md-list" key={`list${key++}`}>
            {items}
          </ol>
        ) : (
          <ul className="md-list" key={`list${key++}`}>
            {items}
          </ul>
        )
      )
      continue
    }

    if (line.trim() === '') {
      blocks.push(<div className="md-gap" key={`gap${key++}`} />)
      i += 1
      continue
    }

    blocks.push(
      <div className="md-p" key={`p${key++}`}>
        {renderInline(line, onOpen, linkClassName)}
      </div>
    )
    i += 1
  }

  return <Fragment>{blocks}</Fragment>
}
