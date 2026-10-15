import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { shareOptions } from '../livekit-share.mjs'

test('teto fixo 32 Mbps, SVC apenas AV1/VP9', () => {
  const track = (width, height) => ({ getSettings: () => ({ width, height }) })
  const full = shareOptions(track(1920,1080), 60, 'video/H264')
  assert.equal(full.screenShareEncoding.maxBitrate, 32_000_000)
  assert.equal(full.simulcast, false)
  assert.equal(full.scalabilityMode, undefined)
  assert.equal(full.degradationPreference, 'maintain-framerate')
  const source = shareOptions(track(3840,2160), 60, 'video/AV1')
  assert.equal(source.screenShareEncoding.maxBitrate, 32_000_000)
  assert.equal(source.scalabilityMode, 'L1T3')
  assert.equal(source.degradationPreference, 'maintain-resolution')
  assert.equal(shareOptions(track(1280,720),30,'video/VP9').screenShareEncoding.maxBitrate,32_000_000)
})

test('áudio privado excluído mesmo quando a janela do cliente é escolhida', () => {
  const source = readFileSync('electron/main.js', 'utf8')
  const constants = source.match(/const AUDIO_NEVER = .*/)[0] + '\n' + source.match(/const LINUX_NODE = .*/)[0]
  const fn = source.slice(source.indexOf('function linuxSelect ('), source.indexOf('function linuxPidOfHwnd ('))
  const select = vm.runInNewContext(constants + '\n' + fn + '\nlinuxSelect')
  for (const name of ['Discord','discord-canary','vesktop','Vencord','equibop','FockyTV','app.vesktop.Vesktop','/app/bin/vencord']) {
    for (const key of ['application.process.binary','application.name','application.id','node.name']) {
      const props = { 'media.class':'Stream/Output/Audio', 'application.process.pid':42, [key]:name }
      assert.equal(select(props,{mode:'exclude'}),false,name)
      assert.equal(select(props,{mode:'window',pid:42}),false,name)
    }
  }
  assert.equal(select({'media.class':'Stream/Output/Audio','application.process.binary':'firefox'},{mode:'exclude'}),true)
})

import { connectShare } from '../livekit-share.mjs'

test('qualidade muda na mesma sessão, preserva áudio e restaura após falha', async () => {
  const original = { window: globalThis.window, fetch: globalThis.fetch, MediaStream: globalThis.MediaStream }
  let constraints = { frameRate: { max: 30 } }, fail = false, rooms = 0, audioPublications = 0
  let parameters = { encodings: [{ maxFramerate: 30 }] }
  const source = {
    getSettings: () => ({ width: 1920, height: 1080 }),
    getConstraints: () => structuredClone(constraints),
    applyConstraints: async value => { constraints = structuredClone(value) },
  }
  const video = { mediaStreamTrack: source, publishOptions: {}, setDegradationPreference: async () => {}, sender: {
    getParameters: () => structuredClone(parameters),
    setParameters: async value => { if (fail) { fail = false; throw new Error('encoder recusou') }; parameters = structuredClone(value) },
  } }
  globalThis.window = { LivekitClient: {
    Room: class {
      constructor() { rooms++; this.localParticipant = { publishTrack: async track => {
        if (track === source) return { track: video }
        audioPublications++; return { track: { mediaStreamTrack: track } }
      } } }
      on() {}
      async connect() {}
      async disconnect() {}
    },
    RoomEvent: {}, Track: { Source: {} }, AudioPresets: {},
  } }
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ token: 'test', path: '/livekit' }) })
  globalThis.MediaStream = class {}
  try {
    const session = await connectShare('https://example.com', 'room', 'publisher', 'test', null, () => {}, {
      getVideoTracks: () => [source], getAudioTracks: () => [{}],
    }, 30, 'video/H264')
    const high = { frameRate: { max: 60 }, height: { max: 1080 } }
    await session.updateQuality(source, high, 60)
    assert.deepEqual(constraints, high)
    assert.equal(parameters.encodings[0].maxFramerate, 60)
    assert.equal(video.publishOptions.screenShareEncoding.maxFramerate, 60)
    fail = true
    await assert.rejects(session.updateQuality(source, { frameRate: { max: 15 } }, 15), /encoder recusou/)
    assert.deepEqual(constraints, high)
    assert.equal(parameters.encodings[0].maxFramerate, 60)
    await Promise.all([
      session.updateQuality(source, { frameRate: { max: 15 } }, 15),
      session.updateQuality(source, { frameRate: { max: 30 } }, 30),
    ])
    assert.equal(parameters.encodings[0].maxFramerate, 30)
    assert.equal(constraints.frameRate.max, 30)
    assert.equal(rooms, 1)
    assert.equal(audioPublications, 1)
    await assert.rejects(session.updateQuality(source, high, NaN), /FPS inválido/)
    assert.equal(constraints.frameRate.max, 30)
    await assert.rejects(session.updateQuality(source, high, 60, async () => session.close()), /encerrada/)
    assert.equal(parameters.encodings[0].maxFramerate, 30)
    await assert.rejects(session.updateQuality(source, high, 60), /encerrada/)
  } finally { Object.assign(globalThis, original) }
})

test('controle aplica seletores durante transmissão sem tocar no áudio nem parar sessão', async () => {
  const { JSDOM } = await import('jsdom')
  const html = readFileSync('ui/index.html', 'utf8')
  const dom = new JSDOM(html)
  const $ = selector => dom.window.document.querySelector(selector)
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.open = true }
  dom.window.HTMLDialogElement.prototype.close = function () { this.open = false }
  const calls = []
  const source = { getConstraints: () => ({ cursor: 'always' }) }
  const session = { livekit: true, updateQuality: async (...args) => { calls.push(args) } }
  const context = vm.createContext({ document: dom.window.document, $, pc: session,
    stream: { getVideoTracks: () => [source] }, shareBusy: false,
    FLUXER_DIMENSIONS: { 720: [1280, 720] }, overlay: null,
  })
  const start = html.indexOf('const qualityDialog =')
  vm.runInContext(html.slice(start, html.indexOf("$('#share').onclick =", start)), context)
  $('#quality').onclick()
  $('#live-qual').value = '720'
  $('#live-fps').value = '30'
  await $('#quality-apply').onclick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], source)
  assert.equal(calls[0][1].width.max, 1280)
  assert.equal(calls[0][1].height.max, 720)
  assert.equal(calls[0][1].frameRate.max, 30)
  assert.equal(calls[0][1].cursor, 'always')
  assert.equal($('#qual').value, '720')
  assert.equal($('#fps').value, '30')
  let oldStopped = false, replacement
  const output = { getVideoTracks: () => [{ kind: 'video' }], getTracks: () => [] }
  context.overlay = {
    out: { getTracks: () => [{ stop: () => { oldStopped = true } }] },
    canvas: { captureStream: fps => { assert.equal(fps, 60); return output } },
    timer: 7, draw: () => {},
  }
  context.syncComposeSize = () => {}
  context.sender = { replaceTrack: async track => { replacement = track } }
  context.clearInterval = id => assert.equal(id, 7)
  context.setInterval = (_draw, period) => { assert.equal(period, 1000 / 60); return 8 }
  session.updateQuality = async (_source, _constraints, fps, updateOutput) => updateOutput(fps)
  $('#quality').onclick()
  $('#live-fps').value = '60'
  await $('#quality-apply').onclick()
  assert.equal(replacement.kind, 'video')
  assert.equal(context.overlay.out, output)
  assert.equal(context.overlay.timer, 8)
  assert.equal(oldStopped, true)
  assert.equal($('#fps').value, '60')
  session.updateQuality = async () => { throw new Error('Não suportado') }
  $('#quality').onclick()
  $('#live-fps').value = '15'
  await $('#quality-apply').onclick()
  assert.equal($('#fps').value, '60')
  assert.equal($('#quality-error').textContent, 'Não suportado')
  assert.equal(context.pc, session)
})
