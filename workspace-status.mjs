#!/usr/bin/env node
// Cross-repo workspace status for the Listam umbrella directory.
//
// The umbrella is NOT a git repo — each sub-directory is its own. That makes it
// easy for the tree to drift (three separate code reviews of this workspace
// produced three different line numbers for the same files, because each ran
// against a different uncommitted state). This reports, in one place:
//
//   - each repo's branch, HEAD, dirty count and declared version
//   - which revision of listam-packages each app is actually consuming
//   - whether every `file:` @listam link resolves on disk
//   - optionally (--test) the live test outcome per repo
//
// Usage:
//   node listam-tools/workspace-status.mjs            # fast: no test runs
//   node listam-tools/workspace-status.mjs --test     # also run each repo's gate
//   node listam-tools/workspace-status.mjs --json     # machine-readable
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// `ci` is the single entry point every repo's CI also calls — never duplicate
// the gate list here or the two drift apart.
const REPOS = [
    { name: 'listam-packages', gate: ['npm', 'run', 'ci'] },
    { name: 'listam-desktop', gate: ['npm', 'run', 'ci'] },
    { name: 'listam-mobile', gate: ['npm', 'run', 'ci'] },
    { name: 'listam-headless', gate: ['npm', 'run', 'ci'] },
    { name: 'listam-hardware', gate: ['cargo', 'test', '--workspace', '--no-fail-fast'], cwd: 'leaf-peer' },
    { name: 'listam-website', gate: null },
    { name: 'listam-tools', gate: null },
]

const args = new Set(process.argv.slice(2))
const runTests = args.has('--test')
const asJson = args.has('--json')

function git(cwd, ...cmd) {
    try {
        return execFileSync('git', cmd, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    } catch {
        return null
    }
}

function readJson(path) {
    try {
        return JSON.parse(readFileSync(path, 'utf8'))
    } catch {
        return null
    }
}

// The declared version lives in package.json for the node repos and app.json
// (expo.version) for mobile, whose package.json carries no version field.
function versionOf(dir) {
    const pkg = readJson(join(dir, 'package.json'))
    if (pkg?.version && pkg.version !== '0.0.0') return pkg.version
    const app = readJson(join(dir, 'app.json'))
    if (app?.expo?.version) return `${app.expo.version} (app.json)`
    const cargo = join(dir, 'leaf-peer', 'Cargo.toml')
    if (existsSync(cargo)) return 'cargo workspace'
    return pkg?.version ?? '—'
}

// Every app declares @listam/* as file:../listam-packages/packages/<name>, which
// npm install turns into a symlink. A broken link here is the exact failure that
// made listam-mobile's CI fail on every run (ERR_MODULE_NOT_FOUND).
function listamLinks(dir) {
    const pkg = readJson(join(dir, 'package.json'))
    const deps = Object.entries(pkg?.dependencies ?? {}).filter(([name]) => name.startsWith('@listam/'))
    if (!deps.length) return null
    let linked = 0
    const broken = []
    for (const [name, spec] of deps) {
        const modulePath = join(dir, 'node_modules', name)
        if (!existsSync(modulePath)) { broken.push(`${name} (missing)`); continue }
        try {
            const real = realpathSync(modulePath)
            if (statSync(real).isDirectory()) linked++
            else broken.push(`${name} (not a directory)`)
        } catch {
            broken.push(`${name} (dangling: ${spec})`)
        }
    }
    return { total: deps.length, linked, broken }
}

function runGate(repo, dir) {
    if (!repo.gate) return null
    const cwd = repo.cwd ? join(dir, repo.cwd) : dir
    const started = Date.now()
    try {
        const out = execFileSync(repo.gate[0], repo.gate.slice(1), {
            cwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 20 * 60_000,
        })
        return { ok: true, ms: Date.now() - started, summary: summarize(out) }
    } catch (e) {
        const out = `${e.stdout ?? ''}${e.stderr ?? ''}`
        return { ok: false, ms: Date.now() - started, summary: summarize(out) }
    }
}

function summarize(output) {
    // Sum EVERY summary block, not just the first: a repo's `ci` may chain
    // several `node --test` runs (mobile does test:security + test:store), and
    // matching once under-reports the total (100 instead of 150).
    const node = [...output.matchAll(/ℹ tests (\d+)\n(?:.*\n)*?ℹ pass (\d+)\nℹ fail (\d+)/g)]
    if (node.length) {
        const total = node.reduce((n, m) => n + Number(m[1]), 0)
        const pass = node.reduce((n, m) => n + Number(m[2]), 0)
        const fail = node.reduce((n, m) => n + Number(m[3]), 0)
        return `${pass}/${total} pass, ${fail} fail`
    }
    const cargo = [...output.matchAll(/test result: \w+\. (\d+) passed; (\d+) failed/g)]
    if (cargo.length) {
        const pass = cargo.reduce((n, m) => n + Number(m[1]), 0)
        const fail = cargo.reduce((n, m) => n + Number(m[2]), 0)
        return `${pass} passed, ${fail} failed`
    }
    return '—'
}

const rows = []
for (const repo of REPOS) {
    const dir = join(ROOT, repo.name)
    if (!existsSync(dir)) { rows.push({ name: repo.name, missing: true }); continue }
    const dirtyRaw = git(dir, 'status', '--porcelain')
    rows.push({
        name: repo.name,
        branch: git(dir, 'rev-parse', '--abbrev-ref', 'HEAD') ?? '(not a git repo)',
        head: git(dir, 'rev-parse', '--short', 'HEAD') ?? '—',
        headDate: git(dir, 'log', '-1', '--format=%ad', '--date=short') ?? '—',
        dirty: dirtyRaw ? dirtyRaw.split('\n').filter(Boolean).length : 0,
        version: versionOf(dir),
        links: listamLinks(dir),
        gate: runTests ? runGate(repo, dir) : null,
    })
}

// The revision every app is actually consuming: with file: links they all read
// one working tree, so a dirty listam-packages means no app is running the code
// its own commit claims.
const pkgRow = rows.find((r) => r.name === 'listam-packages')

if (asJson) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), consumedPackagesRevision: pkgRow?.head, repos: rows }, null, 2))
} else {
    const pad = (s, n) => String(s ?? '—').padEnd(n)
    console.log(`Listam workspace — ${new Date().toISOString()}\n`)
    console.log(pad('repo', 18) + pad('branch', 10) + pad('HEAD', 10) + pad('date', 12) + pad('dirty', 7) + pad('version', 18) + pad('@listam links', 16) + (runTests ? 'gate' : ''))
    console.log('-'.repeat(runTests ? 110 : 91))
    for (const r of rows) {
        if (r.missing) { console.log(pad(r.name, 18) + '(directory not found)'); continue }
        const links = r.links ? `${r.links.linked}/${r.links.total}${r.links.broken.length ? ' BROKEN' : ''}` : '—'
        const gate = r.gate ? `${r.gate.ok ? 'PASS' : 'FAIL'} ${r.gate.summary} (${(r.gate.ms / 1000).toFixed(0)}s)` : ''
        console.log(pad(r.name, 18) + pad(r.branch, 10) + pad(r.head, 10) + pad(r.headDate, 12) + pad(r.dirty || '-', 7) + pad(r.version, 18) + pad(links, 16) + gate)
    }
    for (const r of rows) {
        for (const b of r.links?.broken ?? []) console.log(`\n  ! ${r.name}: ${b}`)
    }
    console.log(`\nAll apps consume listam-packages @ ${pkgRow?.head}${pkgRow?.dirty ? ` + ${pkgRow.dirty} uncommitted path(s)` : ''} via file: links.`)
    if (pkgRow?.dirty) console.log('  ⚠ listam-packages is dirty — no app is running the code its own commit claims.')
    const totalDirty = rows.reduce((n, r) => n + (r.dirty ?? 0), 0)
    console.log(`Total uncommitted paths across the workspace: ${totalDirty}`)
}
