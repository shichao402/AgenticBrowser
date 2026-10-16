import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const semverPattern =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/

function readJson(name) {
  return JSON.parse(readFileSync(join(root, name), 'utf8'))
}

function declaredVersion() {
  const version = readJson('VERSION.json').version
  if (typeof version !== 'string' || !semverPattern.test(version)) {
    throw new Error(`VERSION.json 的 version 必须是语义化版本，当前是 ${String(version)}`)
  }
  return version
}

function mismatches(version) {
  const packageJson = readJson('package.json')
  const lockfile = readJson('package-lock.json')
  const found = []
  if (packageJson.version !== version) {
    found.push(`package.json version 是 ${packageJson.version}，VERSION.json 是 ${version}`)
  }
  if (lockfile.version !== version) {
    found.push(`package-lock.json version 是 ${lockfile.version}，VERSION.json 是 ${version}`)
  }
  const lockedPackageVersion = lockfile.packages?.['']?.version
  if (lockedPackageVersion !== version) {
    found.push(
      `package-lock.json packages[""].version 是 ${lockedPackageVersion}，VERSION.json 是 ${version}`
    )
  }
  return found
}

function check() {
  const version = declaredVersion()
  const found = mismatches(version)
  if (found.length > 0) {
    throw new Error(`${found.join('\n')}\n先修改 VERSION.json，再运行 npm run version:sync`)
  }
  return version
}

function sync() {
  const version = declaredVersion()
  if (mismatches(version).length === 0) {
    console.log(`版本已是 ${version}`)
    return
  }
  const result = spawnSync(
    'npm',
    ['version', version, '--no-git-tag-version', '--allow-same-version'],
    {
      cwd: root,
      stdio: 'inherit',
      shell: true
    }
  )
  if (result.status !== 0) {
    process.exit(result.status ?? 1)
  }
  const found = mismatches(version)
  if (found.length > 0) {
    throw new Error(found.join('\n'))
  }
  console.log(`已将 package.json 与 package-lock.json 同步为 ${version}`)
}

function main() {
  const command = process.argv[2]
  if (command === 'print') {
    process.stdout.write(`${declaredVersion()}\n`)
    return
  }
  if (command === 'check') {
    console.log(`VERSION.json ${check()}`)
    return
  }
  if (command === 'sync') {
    sync()
    return
  }
  throw new Error('用法: node scripts/version-ssot.mjs <print|check|sync>')
}

try {
  main()
} catch (error) {
  console.error(error instanceof Error ? error.message : error)
  process.exit(1)
}
