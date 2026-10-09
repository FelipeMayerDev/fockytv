import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

const html = readFileSync('ui/index.html', 'utf8')
const code = html.slice(html.indexOf('async function quickShare ('), html.indexOf("$('#stop').onclick = stop"))
function setup({ failAudio = false, wayland = false } = {}) {
  const dom = new JSDOM(html)
  const $ = s => dom.window.document.querySelector(s)
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute('open') }
  const calls = [], tracks = [{ kind: 'video', stop: () => calls.push(['track-stop']) }]
  const captured = { getAudioTracks: () => tracks.filter(t => t.kind === 'audio'), getTracks: () => tracks, addTrack: t => tracks.push(t) }
  const context = vm.createContext({
    $, document: dom.window.document, cfg: { audioFilter: true, windowFilter: true, wayland }, nick: 'tester',
    pc: null, stream: null, shareBusy: false, pendingShortcut: null, swapping: false, camOnly: false,
    picked: null, pickedIsWindow: false, shareSrc: 'yt-audio',
    fockyApi: {
      shareSource: async ({mode}) => { calls.push(['source', mode]); return {id:mode === 'active' ? 'window:456:0' : 'screen:0:0',isWindow:mode === 'active'} },
      pick: async id => calls.push(['pick', id]), onShareShortcut: () => {},
      shareFeedback: o => calls.push(['feedback', o.kind]),
    },
    hwEncoders: async () => ({}), pickShareCodec: () => ({first:'video/h264',swH264Clamp:true}),
    hwndOf: id => id.startsWith('window:') ? id.split(':')[1] : null, hwndNum: Number,
    capture: async (...args) => { calls.push(['capture', ...args]); return captured },
    startFilteredAudio: async opts => { calls.push(['audio', opts.mode]); if(failAudio)throw Error('helper falhou'); return {kind:'audio',stop:()=>calls.push(['track-stop'])} },
    stopFilteredAudio: () => calls.push(['audio-stop']),
    publish: async (_nick, stream, fps) => { calls.push(['publish', fps, stream.getAudioTracks().length]); return {} },
    setLive: on => calls.push(['live', on]), sfx: {live:()=>calls.push(['sound','live']),end:()=>calls.push(['sound','end'])},
    stop: () => { calls.push(['stop']); context.pc = null }, toast: msg => calls.push(['toast',msg]),
  })
  vm.runInContext(code, context)
  return { context, calls, $, run: mode => vm.runInContext(`quickShare({mode:'${mode}'})`, context) }
}

test('atalhos forçam 60 fps e áudio filtrado, inclusive com clamp H264 de software', async () => {
  for (const mode of ['active','screen']) {
    const { calls,run,$ } = setup()
    $('#fps').value = '30'
    $('#audio').checked = false
    await run(mode)
    assert.deepEqual(calls.find(c=>c[0]==='capture').slice(1,3),[60,false])
    assert.deepEqual(calls.find(c=>c[0]==='publish'),['publish',60,1])
    assert.deepEqual(calls.find(c=>c[0]==='audio'),['audio',mode==='active'?'window':'exclude'])
    assert(calls.some(c=>c[0]==='sound' && c[1]==='live'))
    await run(mode)
    assert(calls.some(c=>c[0]==='stop'))
    assert.equal(calls.filter(c=>c[0]==='publish').length,1)
  }
})

test('filtro que falha aborta publicação, libera a captura e avisa erro', async () => {
  const {run,calls,context} = setup({failAudio:true})
  await run('screen')
  assert(!calls.some(c=>c[0]==='publish'))
  assert(calls.some(c=>c[0]==='track-stop'))
  assert(calls.some(c=>c[0]==='feedback' && c[1]==='error'))
  assert.equal(context.stream,null)
  assert.equal(context.shareBusy,false)
})

test('atalhos simultâneos não abrem duas capturas, cancelamento do portal não anuncia início', async () => {
  const {run,calls,context} = setup({wayland:true})
  let release
  context.fockyApi.shareSource = () => new Promise((_resolve,reject)=>{release=()=>reject(Error('cancelado'))})
  const first = run('active')
  await run('screen')
  release()
  await first
  assert(!calls.some(c=>c[0]==='publish' || c[0]==='live'))
  assert.equal(calls.filter(c=>c[0]==='feedback' && c[1]==='select').length,1)
  assert.equal(context.shareBusy,false)
})

test('overlay acompanha as transições reais, sem avisar encerramento no boot', () => {
  const dom = new JSDOM(html), events=[]
  const context = vm.createContext({ $:s=>dom.window.document.querySelector(s),shareLive:false,camOnly:false,rpcUpdate:()=>{},fockyApi:{shareFeedback:o=>events.push(o.kind)} })
  const setLive = html.slice(html.indexOf('function setLive ('),html.indexOf('// ── Rich Presence'))
  vm.runInContext(setLive,context)
  vm.runInContext('setLive(false);setLive(true);setLive(true);setLive(false)',context)
  assert.deepEqual(events,['started','stopped'])
})
