// Integração opcional com Discord Activities.
// Carregado por index.html como módulo; fora do Discord não faz nada.
//
// O SDK vive em https://esm.sh/@discord/embedded-app-sdk porque o ui/ não tem
// bundle step. Se um dia o ui/ ganhar build, trocar por dependência local.
const SDK_URL = 'https://esm.sh/@discord/embedded-app-sdk'

// O Discord abre a Activity com ?frame_id= (entre outros query params). Sem
// isso estamos no Electron ou num navegador comum — init nem é tentado.
export const inDiscord = new URLSearchParams(location.search).has('frame_id')

let sdk = null

export async function initDiscord () {
  if (!inDiscord || sdk) return sdk
  const { default: DiscordSDK } = await import(SDK_URL)
  sdk = new DiscordSDK()
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
