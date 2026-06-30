const p = new URLSearchParams(location.search);
const err = p.get('err');
const box = document.getElementById('errBox');
if(err === 'used') {
  box.style.display = 'block';
  box.className = 'err';
  box.textContent = 'Tento přístupový odkaz byl již použit. Požádejte správce o nový odkaz.';
} else if(err === 'invalid') {
  box.style.display = 'block';
  box.className = 'err';
  box.textContent = 'Přístupový odkaz je neplatný nebo vypršel.';
}
