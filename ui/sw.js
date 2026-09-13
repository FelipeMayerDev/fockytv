// Service worker só pra habilitar o "instalar" do Chrome (ele exige um com
// handler de fetch). Deliberadamente sem cache: FockyTV é ao vivo, offline
// não existe, e um cache aqui só serviria pra servir UI velha.
self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
self.addEventListener('fetch', () => {})
