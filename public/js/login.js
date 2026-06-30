// Při načtení stránky: pokud URL obsahuje ?change=1 → zobraz formulář změny hesla
(function() {
  if (new URLSearchParams(window.location.search).get('change') === '1') {
    showChangeForm();
  }
})();

// P2 #5: on* atributy přesunuty z HTML do addEventListener (CSP bez 'unsafe-inline')
document.getElementById('loginBtn').addEventListener('click', doLogin);
document.getElementById('chgBtn').addEventListener('click', doChangePassword);

document.getElementById('password').addEventListener('keydown', e => {
  if (e.key === 'Enter') doLogin();
});
document.getElementById('newPassword2').addEventListener('keydown', e => {
  if (e.key === 'Enter') doChangePassword();
});

async function doLogin() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value;
  const btn = document.getElementById('loginBtn');
  const err = document.getElementById('errBox');
  err.style.display = 'none';
  if (!username || !password) { showErr('Vyplňte jméno a heslo.'); return; }
  btn.disabled = true;
  btn.textContent = 'Přihlašuji...';
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      if (data.must_change_password) {
        // Vynucená změna hesla — zobraz formulář bez přesměrování
        history.replaceState(null, '', '/login?change=1');
        showChangeForm();
      } else if (data.role === 'superadmin') {
        // superadmin stojí nad obalovnami → rozcestník, ne harmonogram
        window.location.href = '/superadmin';
      } else if (data.role === 'hmg_share') {
        // hmg_share uživatel → rovnou na dashboard
        window.location.href = '/dashboard';
      } else {
        window.location.href = '/';
      }
    } else {
      showErr(data.error || 'Nesprávné jméno nebo heslo.');
      btn.disabled = false;
      btn.textContent = 'Přihlásit se';
    }
  } catch (e) {
    showErr('Chyba připojení k serveru.');
    btn.disabled = false;
    btn.textContent = 'Přihlásit se';
  }
}

async function doChangePassword() {
  const p1 = document.getElementById('newPassword').value;
  const p2 = document.getElementById('newPassword2').value;
  const btn = document.getElementById('chgBtn');
  const err = document.getElementById('chgErrBox');
  err.style.display = 'none';
  if (!p1 || p1.length < 6) { showChgErr('Heslo musí mít alespoň 6 znaků.'); return; }
  if (p1 !== p2) { showChgErr('Hesla se neshodují.'); return; }
  btn.disabled = true;
  btn.textContent = 'Ukládám...';
  try {
    const res = await fetch('/api/change-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword: p1 })
    });
    const data = await res.json();
    if (res.ok && data.ok) {
      window.location.href = '/';
    } else {
      showChgErr(data.error || 'Nepodařilo se uložit heslo.');
      btn.disabled = false;
      btn.textContent = 'Uložit heslo a vstoupit';
    }
  } catch (e) {
    showChgErr('Chyba připojení k serveru.');
    btn.disabled = false;
    btn.textContent = 'Uložit heslo a vstoupit';
  }
}

function showChangeForm() {
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('changeForm').style.display = 'block';
  const f = document.getElementById('newPassword');
  if (f) setTimeout(() => f.focus(), 50);
}

function showErr(msg) {
  const e = document.getElementById('errBox');
  e.textContent = msg;
  e.style.display = 'block';
}

function showChgErr(msg) {
  const e = document.getElementById('chgErrBox');
  e.textContent = msg;
  e.style.display = 'block';
}
