import { copyFileSync, mkdirSync } from 'node:fs'

mkdirSync('ui/vendor', { recursive: true })
copyFileSync('node_modules/livekit-client/dist/livekit-client.umd.js', 'ui/vendor/livekit-client.umd.js')
copyFileSync('node_modules/livekit-client/LICENSE', 'ui/vendor/livekit-client.LICENSE')
console.log('SDK LiveKit copiado para ui/vendor.')
