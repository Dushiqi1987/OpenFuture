import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { join } from 'node:path'
import type { SaveSkillInput, SkillInfo, SkillLibraryEntry } from '../shared/protocol.ts'
import { AppError } from './errors.ts'
import { BUILTIN_SKILLS } from './skill-library.ts'

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/
const MAX_DESCRIPTION = 400
const MAX_BODY = 40_000
const BUILTIN_INDEX = '.openfuture-builtin.json'

/**
 * Skills live one directory per skill under `<userData>/skills/<name>/SKILL.md`.
 * Disabled skills are moved to `<userData>/skills-disabled`, which the agent
 * host never scans, so "停用" really removes them from the session.
 *
 * Built-in templates are seeded on first run (only when the name is absent from
 * both directories, so user edits survive restarts).
 */
export class SkillsStore {
  readonly dir: string
  readonly disabledDir: string
  private readonly builtinFile: string

  constructor(userDataDir: string) {
    this.dir = join(userDataDir, 'skills')
    this.disabledDir = join(userDataDir, 'skills-disabled')
    this.builtinFile = join(this.dir, BUILTIN_INDEX)
  }

  init(): void {
    mkdirSync(this.dir, { recursive: true })
    mkdirSync(this.disabledDir, { recursive: true })
    this.seedBuiltins()
  }

  list(): SkillInfo[] {
    this.init()
    const builtins = new Set(this.readBuiltinNames())
    const skills: SkillInfo[] = []
    for (const [root, enabled] of [
      [this.dir, true],
      [this.disabledDir, false]
    ] as const) {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        // The built-in index file lives inside `skills/`, so hidden files listed
        // as directories never occur; guard anyway.
        if (entry.name.startsWith('.')) continue
        const filePath = join(root, entry.name, 'SKILL.md')
        if (!existsSync(filePath)) continue
        try {
          skills.push(readSkill(entry.name, filePath, enabled, builtins.has(entry.name) ? 'builtin' : 'user'))
        } catch {
          // A malformed skill is skipped; the UI still lists valid ones.
        }
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name))
    return skills
  }

  library(): SkillLibraryEntry[] {
    const installed = new Set(this.list().map((skill) => skill.name))
    return BUILTIN_SKILLS.map((template) => ({
      name: template.name,
      description: template.description,
      installed: installed.has(template.name)
    }))
  }

  installLibrarySkill(name: string): SkillInfo[] {
    const template = BUILTIN_SKILLS.find((item) => item.name === name)
    if (!template) throw new AppError('VALIDATION', `技能库里没有名为 ${name} 的技能`)
    if (this.findSkillDir(name) !== null) throw new AppError('VALIDATION', `技能 ${name} 已经存在`)
    this.writeSkill(name, template.description, template.body, false)
    this.addBuiltinName(name)
    return this.list()
  }

  save(input: SaveSkillInput): SkillInfo[] {
    const name = input.name?.trim().toLowerCase() ?? ''
    if (!NAME_PATTERN.test(name)) {
      throw new AppError('VALIDATION', '技能名只能使用小写字母、数字和短横线（最多 40 个字符）')
    }
    const description = (input.description ?? '').trim()
    if (description.length === 0) throw new AppError('VALIDATION', '技能描述不能为空')
    if (description.length > MAX_DESCRIPTION) {
      throw new AppError('VALIDATION', `技能描述不能超过 ${MAX_DESCRIPTION} 个字符`)
    }
    const body = (input.body ?? '').trim()
    if (body.length === 0) throw new AppError('VALIDATION', '技能内容不能为空')
    if (body.length > MAX_BODY) throw new AppError('VALIDATION', `技能内容不能超过 ${MAX_BODY} 个字符`)

    // Saving a disabled skill re-enables it: the enabled directory is what the
    // agent reads, and the UI treats "save" as an explicit intent to use it.
    this.removeDirIfExists(join(this.disabledDir, name))
    this.writeSkill(name, description, body, input.disableModelInvocation === true)
    return this.list()
  }

  remove(name: string): SkillInfo[] {
    if (!NAME_PATTERN.test(name)) throw new AppError('VALIDATION', '技能名不合法')
    let removed = false
    for (const root of [this.dir, this.disabledDir]) {
      const dir = join(root, name)
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true, force: true })
        removed = true
      }
    }
    if (!removed) throw new AppError('VALIDATION', `没有名为 ${name} 的技能`)
    return this.list()
  }

  setEnabled(name: string, enabled: boolean): SkillInfo[] {
    if (!NAME_PATTERN.test(name)) throw new AppError('VALIDATION', '技能名不合法')
    const from = enabled ? join(this.disabledDir, name) : join(this.dir, name)
    const to = enabled ? join(this.dir, name) : join(this.disabledDir, name)
    if (!existsSync(from)) throw new AppError('VALIDATION', `技能 ${name} 已经${enabled ? '启用' : '停用'}`)
    if (existsSync(to)) {
      throw new AppError('VALIDATION', `目标位置已经有同名技能 ${name}，请先处理冲突`)
    }
    renameSync(from, to)
    return this.list()
  }

  private findSkillDir(name: string): string | null {
    for (const root of [this.dir, this.disabledDir]) {
      const dir = join(root, name)
      if (existsSync(join(dir, 'SKILL.md'))) return dir
    }
    return null
  }

  private writeSkill(name: string, description: string, body: string, disableModelInvocation: boolean): void {
    const dir = join(this.dir, name)
    mkdirSync(dir, { recursive: true })
    const frontmatter = ['---', `name: ${JSON.stringify(name)}`, `description: ${JSON.stringify(description)}`]
    if (disableModelInvocation) frontmatter.push('disable-model-invocation: true')
    frontmatter.push('---', '', body, '')
    writeFileSync(join(dir, 'SKILL.md'), frontmatter.join('\n'), 'utf-8')
  }

  private removeDirIfExists(dir: string): void {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  }

  private seedBuiltins(): void {
    const known = new Set(this.readBuiltinNames())
    let changed = false
    for (const template of BUILTIN_SKILLS) {
      // Only a couple of starters are materialised on first run; the rest stay
      // in the library so "技能库" has something to install.
      if (template.seed !== true) continue
      if (this.findSkillDir(template.name) !== null) continue
      this.writeSkill(template.name, template.description, template.body, false)
      known.add(template.name)
      changed = true
    }
    if (changed) this.writeBuiltinNames([...known].sort())
  }

  private readBuiltinNames(): string[] {
    if (!existsSync(this.builtinFile)) return []
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.builtinFile, 'utf-8'))
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : []
    } catch {
      return []
    }
  }

  private writeBuiltinNames(names: string[]): void {
    writeFileSync(this.builtinFile, `${JSON.stringify(names, null, 2)}\n`, 'utf-8')
  }

  private addBuiltinName(name: string): void {
    const names = new Set(this.readBuiltinNames())
    if (names.has(name)) return
    names.add(name)
    this.writeBuiltinNames([...names].sort())
  }
}

function readSkill(folder: string, filePath: string, enabled: boolean, origin: 'builtin' | 'user'): SkillInfo {
  const raw = readFileSync(filePath, 'utf-8')
  const { meta, body } = parseFrontmatter(raw)
  const name = typeof meta.name === 'string' && meta.name.trim() !== '' ? meta.name.trim() : folder
  const description =
    typeof meta.description === 'string' && meta.description.trim() !== ''
      ? meta.description.trim()
      : firstLine(body).slice(0, 200)
  const disableModelInvocation =
    meta['disable-model-invocation'] === true || meta['disable-model-invocation'] === 'true'
  return {
    name,
    description,
    body,
    filePath,
    dir: join(filePath, '..'),
    enabled,
    origin,
    disableModelInvocation,
    updatedAt: statSync(filePath).mtimeMs
  }
}

function parseFrontmatter(raw: string): { meta: Record<string, unknown>; body: string } {
  if (!raw.startsWith('---')) return { meta: {}, body: raw }
  const end = raw.indexOf('\n---', 3)
  if (end === -1) return { meta: {}, body: raw }
  const header = raw.slice(3, end)
  const body = raw.slice(end + 4).replace(/^\r?\n/, '')
  const meta: Record<string, unknown> = {}
  for (const line of header.split(/\r?\n/)) {
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!match?.[1]) continue
    meta[match[1]] = unquote(match[2] ?? '')
  }
  return { meta, body }
}

function unquote(value: string): string {
  const text = value.trim()
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    try {
      return JSON.parse(text) as string
    } catch {
      return text.slice(1, -1)
    }
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1)
  return text
}

function firstLine(text: string): string {
  return text.split(/\r?\n/).find((line) => line.trim() !== '') ?? ''
}
