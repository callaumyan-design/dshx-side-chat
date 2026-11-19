// Install dshx-side-chat into the desktop profile (the three registrations from
// F:\ds\dsh\dshx-plugins\MAINTENANCE.md). Run only while DSH is NOT running.
//
//   node install-profile.mjs            # install / refresh the copy
//   node install-profile.mjs --dry-run  # show what would change
//
// Backups: <file>.bak-side-chat-<stamp> next to package.json and cordis.patch.yml.
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const NAME = 'dshx-side-chat'
const SPEC = 'file:F:/ds/projects/dshx-side-chat'
const AFTER_BUNDLE = 'dshx-project'
const FILES = ['package.json', 'index.js', 'client.js', 'cordis.patch.yml', 'README.md']
const here = path.dirname(fileURLToPath(import.meta.url))
const PROFILE = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'profiles', 'desktop')
const dry = process.argv.includes('--dry-run')
const log = (...a) => console.log(dry ? '[dry-run]' : '', ...a)

let running = ''
try { running = execSync('tasklist /FI "IMAGENAME eq DeepSeek Harness.exe" /NH', { encoding: 'utf8' }) } catch { console.warn('cannot run tasklist (sandbox?) — make sure DSH is closed') }
if (/DeepSeek Harness\.exe/i.test(running)) {
  console.error('DSH is running — quit it first (tray → 退出).')
  if (!dry) process.exit(2)
}

const d = new Date()
const p2 = (n) => String(n).padStart(2, '0')
const stamp = `${d.getFullYear()}${p2(d.getMonth() + 1)}${p2(d.getDate())}-${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`
const pkgPath = path.join(PROFILE, 'package.json')
const patchPath = path.join(PROFILE, 'cordis.patch.yml')
const hasBom = (p) => { const b = fs.readFileSync(p); return b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf }
for (const p of [pkgPath, patchPath]) if (hasBom(p)) throw new Error('BOM already present before install: ' + p)

for (const p of [pkgPath, patchPath]) {
  const to = `${p}.bak-side-chat-${stamp}`
  log('backup', path.basename(p), '->', path.basename(to))
  if (!dry) fs.copyFileSync(p, to)
}

// node_modules copy (break pnpm hard links before writing).
const target = path.join(PROFILE, 'node_modules', NAME)
log('copy', FILES.join(', '), '->', target)
if (!dry) {
  fs.mkdirSync(target, { recursive: true })
  for (const f of FILES) {
    const to = path.join(target, f)
    if (fs.existsSync(to) && fs.statSync(to).nlink > 1) fs.unlinkSync(to)
    fs.copyFileSync(path.join(here, f), to)
    if (fs.statSync(to).nlink !== 1) throw new Error('still hard-linked: ' + to)
  }
}

const text = fs.readFileSync(pkgPath, 'utf8')
const pkg = JSON.parse(text)
pkg.dependencies[NAME] = SPEC
const bundles = pkg.dsh.profile.bundles
if (!bundles.includes(NAME)) {
  const at = bundles.indexOf(AFTER_BUNDLE)
  bundles.splice(at === -1 ? bundles.length : at + 1, 0, NAME)
}
const nextText = JSON.stringify(pkg, null, 2) + '\n'
log('package.json: dependency + bundle', NAME)
if (!dry && nextText !== text) fs.writeFileSync(pkgPath, nextText)

const yaml = createRequire(pkgPath)('js-yaml')
const patchText = fs.readFileSync(patchPath, 'utf8')
const before = yaml.load(patchText)
if (!before.some((e) => e && e.id === NAME)) {
  const sep = patchText.endsWith('\n') ? '' : '\n'
  const nextPatch = `${patchText}${sep}- id: ${NAME}\n  name: ${NAME}\n`
  const after = yaml.load(nextPatch)
  if (after.length !== before.length + 1 || after.at(-1).id !== NAME) throw new Error('patch append did not parse as expected')
  log('cordis.patch.yml: append - id/name', NAME)
  if (!dry) fs.writeFileSync(patchPath, nextPatch)
} else log('cordis.patch.yml: entry already present')

if (!dry) {
  for (const p of [pkgPath, patchPath]) if (hasBom(p)) fs.writeFileSync(p, fs.readFileSync(p).subarray(3))
  JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
  yaml.load(fs.readFileSync(patchPath, 'utf8'))
  console.log('package.json head bytes:', [...fs.readFileSync(pkgPath).subarray(0, 3)].map((x) => x.toString(16)).join(' '))
}
console.log(dry ? 'dry run done' : 'installed — start DSH')
