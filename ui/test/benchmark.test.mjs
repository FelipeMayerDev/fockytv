import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import { videoSample } from '../benchmark-stats.mjs'
import { benchmarkToken } from '../../tools/livekit-benchmark-token.mjs'

const report = (...rows) => new Map(rows.map(row => [row.id, row]))
const inbound = { id: 'v', ssrc: 1, type: 'inbound-rtp', kind: 'video', timestamp: 1000,
  bytesReceived: 100, framesDecoded: 10, packetsReceived: 100, packetsLost: 5,
  jitterBufferDelay: 1, jitterBufferEmittedCount: 10, framesDropped: 2,
  freezeCount: 1, totalFreezesDuration: 0.5, totalDecodeTime: 0.1 }

test('taxas e congelamentos usam diferenças e o intervalo real', () => {
  const current = { ...inbound, timestamp: 3000, bytesReceived: 4_000_100, framesDecoded: 130,
    packetsReceived: 298, packetsLost: 7, jitterBufferDelay: 19, jitterBufferEmittedCount: 130,
    framesDropped: 5, freezeCount: 3, totalFreezesDuration: 1.75, totalDecodeTime: 0.7 }
  const { metrics } = videoSample(report(current), 'inbound', inbound)
  assert.equal(metrics.fps, 60)
  assert.equal(metrics.mbps, 16)
  assert.equal(metrics.lossPercent, 1)
  assert.equal(metrics.jitterBufferMs, 150)
  assert.equal(metrics.freezes, 2)
  assert.equal(metrics.freezeSeconds, 1.25)
  assert.equal(metrics.droppedFrames, 3)
  assert.equal(metrics.decodeMs, 5)
})

test('primeira amostra e contadores ausentes não inventam zero', () => {
  const { metrics } = videoSample(report(inbound), 'inbound')
  assert.equal(metrics.mbps, null)
  assert.equal(metrics.fps, null)
  assert.equal(metrics.lossPercent, null)
  assert.equal(metrics.rttMs, null)
  assert.equal(metrics.freezes, null)
  assert.equal(videoSample(report(), 'inbound'), null)
})

test('mudança de SSRC, reset e timestamp repetido não geram taxas negativas ou infinitas', () => {
  for (const current of [
    { ...inbound, ssrc: 2, timestamp: 2000 },
    { ...inbound, timestamp: 2000, bytesReceived: 0, framesDecoded: 0, packetsLost: 0 },
    { ...inbound },
  ]) {
    const { metrics } = videoSample(report(current), 'inbound', inbound)
    assert.equal(metrics.mbps, null)
    assert.equal(metrics.fps, null)
    assert.equal(metrics.lossPercent, null)
  }
})

test('publicação mede encode e lê o par ICE selecionado, sem usar um candidato antigo', () => {
  const old = { id: 'out', ssrc: 2, type: 'outbound-rtp', kind: 'video', timestamp: 1000, bytesSent: 0, framesEncoded: 0, totalEncodeTime: 0 }
  const current = { ...old, timestamp: 2000, bytesSent: 2_000_000, framesEncoded: 60, totalEncodeTime: 0.3,
    transportId: 'transport', codecId: 'codec', frameWidth: 1920, frameHeight: 1080, qualityLimitationReason: 'cpu' }
  const { metrics } = videoSample(report(current,
    { id: 'transport', type: 'transport', selectedCandidatePairId: 'pair' },
    { id: 'old-pair', type: 'candidate-pair', currentRoundTripTime: 9 },
    { id: 'pair', type: 'candidate-pair', currentRoundTripTime: 0.04, localCandidateId: 'candidate' },
    { id: 'candidate', type: 'local-candidate', protocol: 'udp', candidateType: 'host' },
    { id: 'codec', type: 'codec', mimeType: 'video/H264', sdpFmtpLine: 'profile-level-id=42e02a' },
  ), 'outbound', old)
  assert.equal(metrics.encodeMs, 5)
  assert.equal(metrics.mbps, 16)
  assert.equal(metrics.rttMs, 40)
  assert.equal(metrics.transport, 'udp')
  assert.equal(metrics.codec, 'video/H264')
  assert.equal(metrics.limitation, 'cpu')
})

test('tokens assinados expiram em duas horas e limitam sala e função', () => {
  const secret = 'a'.repeat(32)
  for (const role of ['publisher', 'viewer']) {
    const [header, payload, signature] = benchmarkToken('test-key', secret, 'compare-test', role, 1000).split('.')
    const claims = JSON.parse(Buffer.from(payload, 'base64url'))
    assert.equal(JSON.parse(Buffer.from(header, 'base64url')).alg, 'HS256')
    assert.equal(signature, createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url'))
    assert.equal(claims.iss, 'test-key')
    assert.equal(claims.nbf, 1000)
    assert.equal(claims.exp, 8200)
    assert.equal(claims.video.room, 'compare-test')
    assert.equal(claims.video.canPublish, role === 'publisher')
    assert.equal(claims.video.canSubscribe, role === 'viewer')
    assert.equal(claims.video.canPublishData, false)
  }
})

test('token recusa segredo curto, sala fora do teste e função inválida', () => {
  assert.throws(() => benchmarkToken('key', 'short', 'compare-test', 'publisher'))
  assert.throws(() => benchmarkToken('key', 'a'.repeat(32), 'music', 'publisher'))
  assert.throws(() => benchmarkToken('key', 'a'.repeat(32), 'compare-<script>', 'viewer'))
  assert.throws(() => benchmarkToken('key', 'a'.repeat(32), 'compare-test', 'admin'))
})

test('publicação WHIP aguarda vídeo disponível e encerra a sessão se RTP não chegar', async () => {
  for (const ready of [true, false]) {
    const dom = new JSDOM(readFileSync(new URL('../benchmark.html', import.meta.url), 'utf8'), { url: 'http://localhost:8180/benchmark.html' })
    dom.window.HTMLMediaElement.prototype.play = async () => {}
    let polls = 0, closed = false, deleted = false, clock = 1000, senderParameters
    dom.window.document.querySelector('#bitrate').value = '8'
    dom.window.document.querySelector('#buffer').value = '300'
    class Connection {
      iceGatheringState = 'complete'
      localDescription = { sdp: 'offer' }
      addEventListener() {}
      removeEventListener() {}
      addTrack() { return { getParameters: () => ({ encodings: [{}] }), setParameters: async parameters => { senderParameters = parameters } } }
      getTransceivers() { return [{ setCodecPreferences() {} }] }
      async createOffer() { return { sdp: 'offer' } }
      async setLocalDescription() {}
      async setRemoteDescription() {}
      async getStats() { return new Map() }
      close() { closed = true }
    }
    const context = vm.createContext({
      window: dom.window, document: dom.window.document, location: dom.window.location,
      URL, AbortSignal, videoSample, RTCPeerConnection: Connection,
      RTCRtpSender: { getCapabilities: () => ({ codecs: [{ mimeType: 'video/H264' }] }) },
      Date: class extends Date { static now() { return clock } },
      setTimeout: (fn, delay) => { if (delay === 250) { clock += 10_000; queueMicrotask(fn) } return 0 },
      clearTimeout() {},
      sourceForTest: { getVideoTracks: () => [{ clone: () => ({ stop() {} }), getSettings: () => ({ width: 1920, height: 1080, frameRate: 60 }) }] },
      fetch: async (url, options) => {
        if (options?.method === 'DELETE') { deleted = true; return new Response(null, { status: 204 }) }
        if (url.endsWith('/api/whip')) return new Response('answer', { status: 201, headers: { Location: '/api/whip/test' } })
        assert.ok(url.endsWith('/api/status'))
        polls++
        return Response.json(ready && polls === 3 ? [{ streamKey: 'compare-1080p60', videoTracks: [{}] }] : [])
      },
    })
    const code = readFileSync(new URL('../benchmark.mjs', import.meta.url), 'utf8').replace(/^import .*\n/, '')
    vm.runInContext(code + '\nsource = sourceForTest', context)
    const started = vm.runInContext('start("publisher")', context)
    if (ready) {
      await started
      assert.equal(senderParameters.encodings[0].maxBitrate, 8_000_000)
      assert.equal(vm.runInContext('session.run.requested.jitterBufferMs', context), 300)
      assert.equal(vm.runInContext('const receiver = { jitterBufferTarget: null }; tuneReceiver(receiver); receiver.jitterBufferTarget', context), 300)
      assert.equal(closed, false)
      assert.equal(deleted, false)
      vm.runInContext('stop()', context)
    } else {
      await assert.rejects(started, /vídeo não chegou ao servidor/)
    }
    assert.equal(polls, 3)
    assert.equal(closed, true)
    assert.equal(deleted, true)
    dom.window.close()
  }
})
