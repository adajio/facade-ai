import { readdir, stat } from 'node:fs/promises'
import { StartupError } from './config.js'

const modulesDir = new URL('../modules/', import.meta.url)
const libraryModules = new Set(['converter-port'])

export async function findModules(): Promise<string[]> {
  const entries = await readdir(modulesDir, { withFileTypes: true })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') return []
      throw error
    })
  const names = entries
    .filter((entry) => entry.isDirectory() && /^[a-z][a-z0-9_-]*$/.test(entry.name))
    .map((entry) => entry.name)
    .sort()

  const indexes = await Promise.all(names.map(async (name) => {
    try {
      return (await stat(new URL(`${name}/index.js`, modulesDir))).isFile()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }))
  return names.filter((_, index) => indexes[index])
}

export async function loadModule(name: string): Promise<Record<string, unknown>> {
  try {
    return await import(new URL(`${name}/index.js`, modulesDir).href)
  } catch {
    throw new StartupError(`Could not load module ${name}`)
  }
}

export async function findApiModules(): Promise<string[]> {
  return (await findModules()).filter((name) => !libraryModules.has(name))
}
