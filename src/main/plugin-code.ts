import { isBuiltin } from 'node:module'
import { parse } from '@babel/parser'
import { packageForImport, parsePluginPackageSpec } from '../shared/plugin-packages.ts'

/** Validate the extension without running it and keep ranges for packages it imports. */
export function validateAdaptedCode(code: string): string[] {
  const ast = parse(code, { sourceType: 'module', createImportExpressions: true })
  if (!ast.program.body.some((node) =>
    node.type === 'ExportDefaultDeclaration' &&
    ['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression'].includes(node.declaration.type)
  )) throw new Error('适配代码必须默认导出扩展函数')

  const declared = new Map<string, string>()
  for (const comment of ast.comments ?? []) {
    if (comment.type !== 'CommentLine' || (comment.loc?.start.line ?? 13) > 12) continue
    const header = /^\s*deps:\s*(.+)$/i.exec(comment.value)?.[1]
    if (!header) continue
    for (const value of header.split(',')) {
      const spec = parsePluginPackageSpec(value)
      if (!spec) throw new Error(`无效的 npm 依赖声明：${value.trim()}`)
      declared.set(spec.name, value.trim())
    }
  }
  const imported = new Set<string>()
  const addImport = (source: unknown): void => {
    const literal = source as { type?: string; value?: string } | null | undefined
    if (!literal) return
    const value = literal.type === 'StringLiteral' ? literal.value : undefined
    const name = value && packageForImport(value)
    if (!name || !value || isBuiltin(value)) throw new Error(`适配代码包含不支持的模块导入：${value ?? '动态表达式'}`)
    imported.add(name)
  }
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const child of value) visit(child)
      return
    }
    if (!value || typeof value !== 'object') return
    const node = value as Record<string, unknown>
    if (node.type === 'ImportDeclaration' || node.type === 'ImportExpression' ||
        node.type === 'ExportNamedDeclaration' || node.type === 'ExportAllDeclaration') addImport(node.source)
    const callee = node.callee as { type?: string; name?: string } | undefined
    if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
        callee?.type === 'Identifier' && callee.name === 'require') {
      throw new Error('适配代码使用了 require，请改用 ESM import')
    }
    for (const child of Object.values(node)) visit(child)
  }
  visit(ast.program)
  if (imported.size > 6) throw new Error('适配代码的直接 npm 依赖超过 6 个')
  return [...imported].map((name) => declared.get(name) ?? name)
}
