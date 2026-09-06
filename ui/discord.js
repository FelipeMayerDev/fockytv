// Integração opcional com Discord Activities.
// Carregado por index.html como módulo; fora do Discord não faz nada.
//
// O SDK vive em https://esm.sh/@discord/embedded-app-sdk porque o ui/ não tem
// bundle step. Se um dia o ui/ ganhar build, trocar por dependência local.
const SDK_URL = 'https://esm.sh/@discord/embedded-app-sdk'

// Application ID do app "FockyTV" no Discord Developer Portal. O SDK exige
// no construtor; fora do iframe do Discord ele nunca é usado.
const CLIENT_ID = '1546036535881637898'

// O Discord abre a Activity com ?frame_id= (entre outros query params). Sem
// isso estamos no Electron ou num navegador comum — init nem é tentado.
export const inDiscord = new URLSearchParams(location.search).has('frame_id')

let sdk = null

export async function initDiscord () {
  if (!inDiscord || sdk) return sdk
  const { default: DiscordSDK } = await import(SDK_URL)
  sdk = new DiscordSDK(CLIENT_ID)
  await sdk.ready()
  console.info('[fockytv/discord] activity ready', {
    channelId: sdk.channelId,
    userId: sdk.user?.id,
    // displayName local pode vir depois do handshake do client
  })
  return sdk
}

// Apelido sugerido dentro da Activity: username do Discord quando disponível.
export function discordDisplayName (fallback) {
  return sdk?.user?.username ?? fallback
}

// O Discord apaga window.RTCPeerConnection (e cia.) no documento da Activity;
// um iframe aninhado da nossa origem não recebe o patch. Copiamos as RTC*
// de volta antes do app construir os PCs do WHEP.
export async function restoreWebRTC () {
  if (!inDiscord || window.RTCPeerConnection) return
  const f = document.createElement('iframe')
  f.hidden = true
  f.src = new URL('shim.html?v=1', import.meta.url).href
  const done = new Promise((res, rej) => {
    f.onload = () => res()
    f.onerror = () => rej(new Error('shim.html falhou ao carregar'))
    setTimeout(() => rej(new Error('shim.html timeout')), 5000)
  })
  document.body.append(f)
  await done
  const w = f.contentWindow
  for (const k of ['RTCPeerConnection', 'RTCSessionDescription', 'RTCIceCandidate',
    'RTCRtpSender', 'RTCRtpReceiver', 'RTCRtpTransceiver', 'RTCError'])
    if (!window[k] && w[k]) window[k] = w[k]
  return window.RTCPeerConnection ? 'restored' : 'unavailable'
}
