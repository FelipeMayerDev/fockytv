import assert from 'node:assert/strict'
import test from 'node:test'
import { pickLyrics } from '../lyrics.js'

const lrc = (...lines) => lines.map(([t, text]) => `[00:${String(t).padStart(5, '0')}] ${text}`).join('\n')
const song = (shift = 0) => lrc([10 + shift, 'um'], [20 + shift, 'dois'], [30 + shift, 'três'], [40 + shift, 'quatro'])

test('letra: desempata pela que concorda com as outras e compensa introdução do clipe', () => {
  const bad = { id: 1, duration: 200, syncedLyrics: lrc([5, 'hey'], [12, 'um'], [22, 'dois'], [32, 'três']) }
  const good = [2, 3].map(id => ({ id, duration: 200, syncedLyrics: song() }))
  assert.equal(pickLyrics([bad, ...good, good[0]], 200)[0].t, 10, 'entrada fora da curva perde mesmo vindo primeiro (e duplicada não conta)')
  assert.equal(pickLyrics([...good, { id: 4, duration: 205, syncedLyrics: song(3) }], 205)[0].t, 13, 'duração mais próxima ainda vence')
  assert.equal(pickLyrics(good, 206)[0].t, 16, 'vídeo 6 s mais longo: introdução')
  assert.equal(pickLyrics(good, 201)[0].t, 10, 'diferença pequena é arredondamento')
  assert.equal(pickLyrics([], 200), null)
})
