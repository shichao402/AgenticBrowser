// @ts-check
// 守住 src/main/updater/gen 与 proto/ 一致：重新生成到临时目录后逐文件比对。
// 生成物入库是为了让 typecheck 与构建不依赖 buf；这里保证它没被手改、也没忘了重生成。
//
//   node scripts/proto-check.mjs   比对（纳入 npm run check）
//   npm run proto:gen              重新生成

import { spawnSync } from 'node:child_process'
import {
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), '..')
const GENERATED = join('src', 'main', 'updater', 'gen')

/**
 * @param {string} directory
 * @returns {string[]}
 */
function listFiles(directory) {
  /** @type {string[]} */
  const files = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) {
      files.push(...listFiles(path))
    } else {
      files.push(path)
    }
  }
  return files
}

/**
 * @param {string} directory
 * @returns {Map<string, string>}
 */
function snapshot(directory) {
  const files = new Map()
  for (const path of listFiles(directory)) {
    files.set(
      relative(directory, path).split('\\').join('/'),
      readFileSync(path, 'utf8')
    )
  }
  return files
}

const scratch = mkdtempSync(join(tmpdir(), 'agentic-proto-'))
try {
  const bin = join(root, 'node_modules', '.bin')
  const result = spawnSync(
    join(bin, process.platform === 'win32' ? 'buf.cmd' : 'buf'),
    ['generate', '--output', scratch],
    {
      cwd: root,
      stdio: ['ignore', 'inherit', 'inherit'],
      shell: process.platform === 'win32',
      env: {
        ...process.env,
        PATH: `${bin}${delimiter}${process.env.PATH ?? ''}`
      }
    }
  )
  if (result.status !== 0) {
    throw new Error(`buf generate 失败（退出码 ${String(result.status)}）`)
  }
  const expected = snapshot(join(scratch, GENERATED))
  const actual = snapshot(join(root, GENERATED))
  const drift = [...new Set([...expected.keys(), ...actual.keys()])].filter(
    (name) => expected.get(name) !== actual.get(name)
  )
  if (drift.length > 0) {
    throw new Error(
      `${GENERATED} 与 proto/ 不一致：${drift.join('、')}。运行 npm run proto:gen 后提交。`
    )
  }
  console.log(`${GENERATED} 与 proto/ 一致（${expected.size} 个文件）`)
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
} finally {
  rmSync(scratch, { recursive: true, force: true })
}
