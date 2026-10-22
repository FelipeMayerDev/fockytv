import assert from 'node:assert/strict'
import test from 'node:test'
import { jamYtState } from '../jam-yt.js'

test('yt: troca, pause, play, seek e snapshot tardio usam o relógio do servidor', () => {
  let clock = 1000
  const room = jamYtState(() => clock)
  assert.equal(room.snapshot(), null)
  room.command({ action: 'load', videoId: 'aaaaaaaaaaa' }, 'ana')
  clock += 4500
  assert.equal(room.snapshot().pos, 4.5)
  const command = { action: 'state', videoId: 'aaaaaaaaaaa', playing: false, pos: 4.5, at: -999 }
  room.command(command, 'bia')
  clock += 5000
  assert.equal(room.snapshot().pos, 4.5)
  room.command({ ...command, action: 'seek', pos: 40 }, 'ana')
  assert.equal(room.snapshot().pos, 40)
  room.command({ ...command, pos: 40, playing: true }, 'bia')
  clock += 2000
  assert.equal(room.snapshot().pos, 42)
  for (const bad of [{ pos: -1 }, { pos: Infinity }, { pos: '3' }, { playing: 1 }, { videoId: 'bbbbbbbbbbb' }, { action: 'other' }, { videoId: ['aaaaaaaaaaa'] }])
    assert.equal(room.command({ ...command, ...bad }, 'x'), null)
  assert.equal(room.snapshot().pos, 42)
  room.command({ action: 'load', videoId: 'bbbbbbbbbbb' }, 'bia')
  assert.equal(room.snapshot().pos, 0)
  assert.equal(room.snapshot().videoId, 'bbbbbbbbbbb')
  assert.equal(jamYtState().snapshot(), null, 'outra sala começa vazia')
})

test('mux de vídeo e áudio usa MP4 sem recodificar e encerra subprocesso ao desconectar', async () => {
  const { EventEmitter } = await import('node:events')
  const { PassThrough } = await import('node:stream')
  const { muxYt } = await import('../jam-yt.js')
  const process = new EventEmitter()
  process.stdout = new PassThrough()
  let killed = false, args
  process.kill = () => { killed = true }
  const res = new PassThrough()
  let contentType
  res.setHeader = (key, value) => { contentType = value }
  muxYt('video-url', 'audio-url', res, (command, argv) => { assert.equal(command, 'ffmpeg'); args = argv; return process })
  assert.ok(args.includes('video-url') && args.includes('audio-url'))
  assert.equal(args[args.indexOf('-c') + 1], 'copy')
  assert.equal(contentType, 'video/mp4')
  res.destroy()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(killed)
  process.emit('close', 0)
})
