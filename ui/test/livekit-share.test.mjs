import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import { shareOptions } from '../livekit-share.mjs'

test('perfil Fluxer: bitrate por pixels, teto 9 Mbps, SVC apenas AV1/VP9', () => {
  const track = (width, height) => ({ getSettings: () => ({ width, height }) })
  const full = shareOptions(track(1920,1080), 60, 'video/H264')
  assert.equal(full.screenShareEncoding.maxBitrate, 6_000_000)
  assert.equal(full.simulcast, false)
  assert.equal(full.scalabilityMode, undefined)
  assert.equal(full.degradationPreference, 'maintain-framerate')
  const source = shareOptions(track(3840,2160), 60, 'video/AV1')
  assert.equal(source.screenShareEncoding.maxBitrate, 9_000_000)
  assert.equal(source.scalabilityMode, 'L1T3')
  assert.equal(source.degradationPreference, 'maintain-resolution')
  assert.equal(shareOptions(track(1280,720),30,'video/VP9').screenShareEncoding.maxBitrate,3_000_000)
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
