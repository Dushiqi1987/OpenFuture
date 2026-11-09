interface WikiDiff {
  changed: boolean
  added: number
  removed: number
  beforeLines: number
  afterLines: number
  hunks: unknown[]
}
export function diffLines(before: string, after: string): WikiDiff
export function renderUnifiedDiff(diff: WikiDiff, options?: { beforeLabel?: string; afterLabel?: string }): string
