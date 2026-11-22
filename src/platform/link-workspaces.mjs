import { lstat, readdir, readlink, symlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const sourceRoot = fileURLToPath(new URL('../modules/', import.meta.url))
const compiledRoot = fileURLToPath(new URL('../../dist/src/modules/', import.meta.url))

async function stat(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

if ((await stat(compiledRoot))?.isDirectory()) {
  for (const module of await readdir(compiledRoot, { withFileTypes: true })) {
    if (!module.isDirectory()) continue
    const source = join(sourceRoot, module.name, 'node_modules')
    if (!(await stat(source))?.isDirectory()) continue

    const compiledWorkspace = join(compiledRoot, module.name)
    const compiled = join(compiledWorkspace, 'node_modules')
    const target = relative(compiledWorkspace, source)
    try {
      await symlink(target, compiled)
    } catch (error) {
      if (error.code !== 'EEXIST' || await readlink(compiled) !== target) throw error
    }
  }
}
