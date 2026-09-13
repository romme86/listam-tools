#!/usr/bin/env node
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const minimum = { autobase: '7.28.2', hyperswarm: '4.17.1', hypercore: '11.36.1', corestore: '7.12.5', hyperdht: '6.34.0' }
const rows = [], failures = []
const atLeast = (version, target) => {
    const a = version.split('.').map(Number), b = target.split('.').map(Number)
    return a[0] > b[0] || a[0] === b[0] && (a[1] > b[1] || a[1] === b[1] && a[2] >= b[2])
}
for (const name of ['listam-packages', 'listam-desktop', 'listam-mobile', 'listam-headless']) {
    const dir = join(root, name)
    const lock = JSON.parse(readFileSync(join(dir, 'package-lock.json'))).packages
    const require = createRequire(join(dir, 'package.json'))
    const versions = {}
    for (const [dependency, target] of Object.entries(minimum)) {
        const locked = lock[`node_modules/${dependency}`]?.version
        // Headless participant resolves Autobase through the linked backend.
        if (!locked && name === 'listam-headless' && dependency === 'autobase') continue
        if (!locked || !atLeast(locked, target)) failures.push(`${name}: ${dependency} must be at least ${target}`)
        let installed
        try { installed = JSON.parse(readFileSync(require.resolve(`${dependency}/package.json`))).version } catch {}
        if (installed !== locked) failures.push(`${name}: installed ${dependency} ${installed} differs from lock ${locked}`)
        versions[dependency] = locked
        for (const [path, entry] of Object.entries(lock)) {
            if (path.endsWith(`/node_modules/${dependency}`) && entry.version && !atLeast(entry.version, target)) failures.push(`${name}: old nested ${dependency} ${entry.version} at ${path}`)
        }
    }
    rows.push({ repository: name, versions })
}
console.log(JSON.stringify({ ok: failures.length === 0, rows, failures }, null, 2))
if (failures.length) process.exitCode = 1
