import { createHmac } from 'node:crypto'
import { pathToFileURL } from 'node:url'

export function benchmarkToken(key, secret, room, role, now = Math.floor(Date.now() / 1000)) {
  if (!key || !secret || secret.length < 32) throw new Error('Defina LIVEKIT_API_KEY e LIVEKIT_API_SECRET (mínimo 32 caracteres).')
  if (!/^compare-[\w.-]{1,24}$/.test(room)) throw new Error('A sala deve começar com compare- e ter até 32 caracteres.')
  if (!['publisher', 'viewer'].includes(role)) throw new Error('Use publisher ou viewer.')
  const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url')
  const data = [encode({ alg: 'HS256', typ: 'JWT' }), encode({
    iss: key, sub: role, nbf: now, exp: now + 7200,
    video: { roomJoin: true, room, canPublish: role === 'publisher', canSubscribe: role === 'viewer', canPublishData: false },
  })].join('.')
  return `${data}.${createHmac('sha256', secret).update(data).digest('base64url')}`
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    console.log(benchmarkToken(process.env.LIVEKIT_API_KEY, process.env.LIVEKIT_API_SECRET, process.argv[2], process.argv[3]))
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
