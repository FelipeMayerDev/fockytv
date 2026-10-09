const params = new URLSearchParams(location.search)
document.querySelector('#message').textContent = params.get('message')
document.body.dataset.kind = params.get('kind')
