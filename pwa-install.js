let deferredInstallPrompt = null;

document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('installButton');
  if (!button) return;

  if (isStandaloneMode()) {
    button.classList.add('hidden');
    return;
  }

  button.classList.remove('hidden');
  button.addEventListener('click', async () => {
    if (deferredInstallPrompt) {
      deferredInstallPrompt.prompt();
      await deferredInstallPrompt.userChoice;
      deferredInstallPrompt = null;
      button.classList.add('hidden');
      return;
    }

    showInstallInstructions();
  });
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
  document.getElementById('installButton')?.classList.remove('hidden');
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  document.getElementById('installButton')?.classList.add('hidden');
  if (typeof showToast === 'function') showToast('Uygulama telefona yüklendi.');
});

function isStandaloneMode() {
  return window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
}

function showInstallInstructions() {
  const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
  const text = isIos
    ? 'Safari paylaş menüsünü açıp “Ana Ekrana Ekle” seçeneğine bas. Uygulama adres çubuğu olmadan açılır.'
    : 'Chrome menüsünü açıp “Uygulamayı yükle” veya “Ana ekrana ekle” seçeneğine bas. Kurulduktan sonra adres çubuğu görünmez.';

  if (typeof showToast === 'function') showToast(text);
  else alert(text);
}
