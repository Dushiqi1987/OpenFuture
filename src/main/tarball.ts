import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { AppError, toErrorMessage } from './errors.ts'

/** 512-byte tar header helpers shared by the market downloader and the dependency installer. */

function readOctal(buffer: Buffer, offset: number, length: number): number {
  const raw = buffer.subarray(offset, offset + length).toString('utf8').replace(/\0.*$/, '').trim()
  if (raw === '') return 0
  const value = Number.parseInt(raw, 8)
  return Number.isFinite(value) ? value : 0
}

function tarName(buffer: Buffer, offset: number): string {
  const name = buffer.subarray(offset, offset + 100).toString('utf8').replace(/\0.*$/, '')
  const prefix = buffer.subarray(offset + 345, offset + 500).toString('utf8').replace(/\0.*$/, '')
  return prefix === '' ? name : `${prefix}/${name}`
}

/** Minimal tar reader: regular files and directories, 512-byte headers. */
export function extractTar(archive: Buffer, targetDir: string): void {
  let offset = 0
  let pendingName: string | null = null
  const root = targetDir
  while (offset + 512 <= archive.length) {
    const header = archive.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const type = String.fromCharCode(header[156] ?? 0)
    const size = readOctal(header, 124, 12)
    const dataStart = offset + 512
    // `tarName` reads a header-relative buffer; passing the archive offset
    // would read size/mtime bytes as a name after the first entry.
    const name = pendingName ?? tarName(header, 0)
    if (type === 'L') {
      pendingName = archive.subarray(dataStart, dataStart + size).toString('utf8').replace(/\0.*$/, '')
      offset = dataStart + Math.ceil(size / 512) * 512
      continue
    }
    pendingName = null
    if (size < 0 || dataStart + size > archive.length) {
      throw new AppError('MARKET_INSTALL_FAILED', '压缩包条目长度无效')
    }
    const clean = name.replace(/^\.\//, '').replace(/^package\//, '')
    if (clean !== '' && !clean.startsWith('/') && !/[\\:]/.test(clean) &&
        !clean.split('/').some((part) => part === '..' || /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
      const dest = join(root, clean)
      if (type === '5' || clean.endsWith('/')) {
        mkdirSync(dest, { recursive: true })
      } else if (type === '0' || type === '\0' || type === '7') {
        mkdirSync(join(dest, '..'), { recursive: true })
        writeFileSync(dest, archive.subarray(dataStart, dataStart + size))
      }
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
}

export interface DownloadOptions {
  timeoutMs?: number
  maxBytes?: number
  label?: string
}

/** Fetch a whole file with a hard size cap; used for plugin tarballs and npm packages. */
export async function downloadBuffer(url: string, options: DownloadOptions = {}): Promise<Buffer> {
  const timeoutMs = options.timeoutMs ?? 120_000
  const maxBytes = options.maxBytes ?? 40 * 1024 * 1024
  const label = options.label ?? '文件'
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new AppError('MARKET_INSTALL_FAILED', `下载${label}失败：HTTP ${response.status}`)
    const length = Number(response.headers.get('content-length') ?? '0')
    if (length > maxBytes) {
      throw new AppError('MARKET_INSTALL_FAILED', `${label}过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB）`)
    }
    const reader = response.body?.getReader()
    if (!reader) return Buffer.alloc(0)
    const chunks: Uint8Array[] = []
    let bytes = 0
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > maxBytes) {
        controller.abort()
        throw new AppError('MARKET_INSTALL_FAILED', `${label}过大（超过 ${Math.round(maxBytes / 1024 / 1024)}MB）`)
      }
      chunks.push(value)
    }
    return Buffer.concat(chunks, bytes)
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError('MARKET_INSTALL_FAILED', `下载${label}失败：${toErrorMessage(error)}`)
  } finally {
    clearTimeout(timer)
  }
}
