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

/**
 * Plain-text message body with clickable file paths and URLs. The surrounding
 * `.message-text` keeps `white-space: pre-wrap`, so text nodes stay verbatim
 * and only the matched ranges become buttons.
 */
export function RichText({ text, onOpen, linkClassName }: RichTextProps): React.JSX.Element {
  const nodes: React.ReactNode[] = []
  let cursor = 0
  LINK_PATTERN.lastIndex = 0
  let match: RegExpExecArray | null
  while ((match = LINK_PATTERN.exec(text)) !== null) {
    const value = match[0]
    const isUrl = value.startsWith('http')
    if (match.index > cursor) nodes.push(text.slice(cursor, match.index))
    nodes.push(
      <button
        type="button"
        key={`${match.index}-${value}`}
        className={['inline-link', isUrl ? 'inline-link-url' : 'inline-link-path', linkClassName ?? '']
          .filter(Boolean)
          .join(' ')}
        title={isUrl ? `在内置浏览器中打开 ${value}` : `打开 ${value}`}
        onClick={() => onOpen(value)}
      >
        {value}
      </button>
    )
    cursor = match.index + value.length
  }
  if (cursor < text.length) nodes.push(text.slice(cursor))
  return <Fragment>{nodes}</Fragment>
}
