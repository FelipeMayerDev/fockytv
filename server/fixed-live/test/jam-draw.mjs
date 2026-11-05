import assert from 'node:assert/strict'
import test from 'node:test'
import { jamDraw } from '../jam-draw.js'

test('draw: traço é relay puro, nada fica gravado', () => {
  const draw = jamDraw()
  assert.deepEqual(draw.sync(), { type: 'draw', action: 'sync', targets: [] })
  const relay = draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 's1', color: 0 }, '111111')
  assert.equal(relay.from, '111111')
  draw.apply({ type: 'draw', target: '222222', action: 'points', id: 's1', pts: [0, 0, 1.234, -5] }, '111111')
  draw.apply({ type: 'draw', target: '222222', action: 'end', id: 's1' }, '111111')
  draw.apply({ type: 'draw', target: '222222', action: 'undo' }, '999999')
  draw.apply({ type: 'draw', target: '222222', action: 'clear' }, '222222')
  assert.deepEqual(draw.sync(), { type: 'draw', action: 'sync', targets: [] }, 'nenhum traço sobrevive no servidor')
})

test('draw: allow é privilégio do dono e persiste por alvo', () => {
  const draw = jamDraw()
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'allow', on: false }, '999999'), null)
  assert.deepEqual(draw.sync().targets, [], 'allow negado nem cria estado')
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'allow', on: false }, '222222').on, false)
  assert.equal(draw.sync().targets[0].allowed, false)
  draw.apply({ type: 'draw', target: '222222', action: 'allow', on: true }, '222222')
  assert.equal(draw.sync().targets[0].allowed, true)
})

test('draw: relay valida a forma e normaliza as coordenadas', () => {
  const draw = jamDraw()
  assert.deepEqual(draw.apply({ type: 'draw', target: '222222', action: 'laser', pts: [1.5, -1] }, '111111').pts, [1, 0])
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'laser', pts: [0.5] }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'laser', pts: ['a', 1] }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 'x', color: 9 }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'begin', id: '', color: 0 }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'begin', id: 'y', color: 0 }, '111111').id, 'y')
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'points', id: 'y', pts: [0.5] }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'wipe' }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: 'lixo', action: 'begin', id: 'z', color: 0 }, '111111'), null)
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'end' }, '111111'), null)
  const points = draw.apply({ type: 'draw', target: '222222', action: 'points', id: 'y', pts: Array.from({ length: 200 }, (_, i) => (i % 100) / 100) }, '111111')
  assert.equal(points.pts.length, 200)
  assert.equal(draw.apply({ type: 'draw', target: '222222', action: 'points', id: 'y', pts: Array.from({ length: 202 }, () => 0.5) }, '111111'), null)
})

test('draw: resync só devolve o toggle e não cria estado', () => {
  const draw = jamDraw()
  draw.apply({ type: 'draw', target: '222222', action: 'allow', on: false }, '222222')
  assert.deepEqual(draw.resync('222222'), { type: 'draw', action: 'sync', targets: [{ target: '222222', allowed: false }] })
  assert.deepEqual(draw.resync('888888').targets, [{ target: '888888', allowed: true }])
  assert.equal(draw.sync().targets.length, 1, 'resync de alvo desconhecido não registra nada')
  assert.equal(draw.resync('abc'), null)
})

test('draw: sala com muitos alvos esquece o menos ativo', () => {
  let clock = 1000
  const draw = jamDraw(() => clock)
  for (let i = 0; i < 8; i++) draw.apply({ type: 'draw', target: `${1000000 + i}`, action: 'allow', on: false }, `${1000000 + i}`)
  clock += 5000
  draw.apply({ type: 'draw', target: '9999999', action: 'allow', on: false }, '9999999')
  const targets = draw.sync().targets.map(entry => entry.target)
  assert.equal(targets.length, 8)
  assert.equal(targets.includes('1000000'), false, 'alvo mais antigo sai')
  assert.equal(targets.includes('9999999'), true)
})
