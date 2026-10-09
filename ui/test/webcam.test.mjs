import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'

const html = readFileSync('ui/index.html', 'utf8')
const code = html.slice(html.indexOf('async function loadWebcams ()'), html.indexOf('async function addCam ('))
function setup(mediaDevices) {
  const { window } = new JSDOM('<dialog id="dlg-share" open data-cam="1"></dialog><select id="webcam"><option value="">Padrão</option></select>')
  const context = vm.createContext({ navigator: { mediaDevices }, Option: window.Option, $: s => window.document.querySelector(s) })
  vm.runInContext(code, context)
  return { run: s => vm.runInContext(s, context), select: window.document.querySelector('#webcam'), dialog: window.document.querySelector('dialog') }
}

test('lista webcams, preserva escolha e exige o dispositivo escolhido nos dois fluxos', async () => {
  const cameras = [{kind:'videoinput', deviceId:'one', label:'Integrada'}, {kind:'videoinput',deviceId:'two',label:'USB'}, {kind:'audioinput',deviceId:'mic',label:'Microfone'}]
  const {run,select} = setup({enumerateDevices:async()=>cameras, getUserMedia:()=>{throw Error('não deveria pedir permissão')}})
  await run('loadWebcams()')
  assert.deepEqual([...select.options].map(o=>o.text), ['Padrão do sistema','Integrada','USB'])
  select.value = 'two'
  await run('loadWebcams()')
  assert.equal(select.value, 'two')
  assert.equal(run('webcamVideo(60).deviceId.exact'), 'two')
  assert.equal(run('webcamVideo().deviceId.exact'), 'two')
  assert.equal(run('webcamVideo(60).frameRate'), 60)
  cameras.splice(1,1)
  await run('loadWebcams()')
  assert.equal(select.value,'')
  assert.equal(run('webcamVideo().facingMode'),'user')
  assert.equal(run('webcamVideo().deviceId'), undefined)
  assert.match(html, /video: webcamVideo\(\), audio: withMic/)
  assert.match(html, /video: webcamVideo\(fps\)/)
})

test('libera captura de permissão mesmo quando a segunda enumeração falha', async () => {
  let calls=0, stopped=0
  const {run}=setup({
    enumerateDevices:async()=>{if(calls++)throw Error('desconectada');return []},
    getUserMedia:async opts=>{assert.equal(opts.audio,false);return {getTracks:()=>[{stop:()=>stopped++}]}},
  })
  await assert.rejects(run('loadWebcams()'),/desconectada/)
  assert.equal(stopped,1)
})

test('não atualiza seletor depois de fechar o diálogo durante a permissão', async () => {
  let stopped=0,calls=0
  const {run,select,dialog}=setup({
    enumerateDevices:async()=>calls++ ? [{kind:'videoinput',deviceId:'usb',label:'USB'}] : [],
    getUserMedia:async()=>{dialog.removeAttribute('open');return {getTracks:()=>[{stop:()=>stopped++}]}},
  })
  await run('loadWebcams()')
  assert.equal(select.options.length,1)
  assert.equal(stopped,1)
})
