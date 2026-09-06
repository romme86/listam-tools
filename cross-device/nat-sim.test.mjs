import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('a missing Docker binary reports SKIP without an unhandled child-process error', () => {
    const runner = fileURLToPath(new URL('./nat-sim/run.mjs', import.meta.url))
    const result = spawnSync(process.execPath, [runner], {
        env: { ...process.env, PATH: '/listam-test-no-docker' }, encoding: 'utf8', timeout: 5000,
    })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /SKIP: no reachable docker daemon/)
    assert.doesNotMatch(result.stderr, /Unhandled|ENOENT/)
})
