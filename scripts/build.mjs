import { cpSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const compiler = resolve(root, 'node_modules/typescript/bin/tsc')
const args = ['-p', 'tsconfig.json', '--noEmitOnError', ...process.argv.slice(2)]
const config = spawnSync(process.execPath, [compiler, ...args, '--showConfig'], { cwd: root, encoding: 'utf8' })
if (config.error) throw config.error
if (config.status !== 0) {
  process.stderr.write(config.stdout + config.stderr)
  process.exit(config.status ?? 1)
}
const { compilerOptions } = JSON.parse(config.stdout)
if (compilerOptions.noEmit || compilerOptions.emitDeclarationOnly || !compilerOptions.outDir) {
  throw new Error('Workbench build requires JavaScript output and an outDir')
}
const build = spawnSync(process.execPath, [compiler, ...args], { cwd: root, stdio: 'inherit' })
if (build.error) throw build.error
if (build.status !== 0) process.exit(build.status ?? 1)
cpSync(resolve(root, 'web'), resolve(root, compilerOptions.outDir, 'web'), { recursive: true })
