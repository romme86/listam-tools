import test from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { lineService } from './driver.mjs'

function fakeProcess() {
    const proc = new EventEmitter()
    proc.stdout = new PassThrough()
    proc.stderr = new PassThrough()
    proc.stdin = new PassThrough()
    return proc
}

test('repeated matrix requests release their process exit listeners', async () => {
    const proc = fakeProcess()
    const service = lineService(proc, 'test')
    proc.stdin.on('data', (data) => {
        const { id } = JSON.parse(data)
        queueMicrotask(() => proc.stdout.write(JSON.stringify({ id, ok: true }) + '\n'))
    })
    for (let i = 0; i < 200; i++) {
        assert.equal((await service.request('dump')).ok, true)
        assert.equal(proc.listenerCount('exit'), 1)
        assert.equal(proc.listenerCount('error'), 0)
    }
    proc.stdout.end(); proc.stderr.end(); proc.stdin.end()
})

test('request timeout releases the exit listener and a later reply is harmless', async () => {
    const proc = fakeProcess()
    const service = lineService(proc, 'test')
    const keepAlive = setTimeout(() => {}, 1000)
    try {
        await assert.rejects(service.request('dump', {}, { timeoutMs: 10 }), /timed out/)
        assert.equal(proc.listenerCount('exit'), 1)
        assert.equal(proc.listenerCount('error'), 0)
        proc.stdout.write('{"id":1,"ok":true}\n')
    } finally { clearTimeout(keepAlive); proc.stdout.end(); proc.stderr.end(); proc.stdin.end() }
})
