const PACKAGE_NAME = '(?:@[a-z0-9_~-][a-z0-9._~-]*/)?[a-z0-9_~-][a-z0-9._~-]*'
const packageNamePattern = new RegExp(`^${PACKAGE_NAME}$`)
const packageSpecPattern = new RegExp(`^(${PACKAGE_NAME})(?:@(.+))?$`)
const importPattern = new RegExp(`^(${PACKAGE_NAME})(?:/[^/]+)*$`)

export function isPluginPackageName(name: string): boolean {
  return packageNamePattern.test(name)
}

export function parsePluginPackageSpec(value: string): { name: string; range: string } | null {
  const match = packageSpecPattern.exec(value.trim())
  return match?.[1] ? { name: match[1], range: match[2]?.trim() || '*' } : null
}

export function packageForImport(specifier: string): string | null {
  return importPattern.exec(specifier)?.[1] ?? null
}
