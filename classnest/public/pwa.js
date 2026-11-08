/* Installation is a user action. The worker never stores account or class data. */
(() => {
  'use strict';
  const controls = [...document.querySelectorAll('[data-install-app]')];
  const dialog = document.getElementById('install-app-dialog');
  const installNow = document.getElementById('install-app-now');
  const status = document.getElementById('install-app-status');
  const networkStatus = document.getElementById('app-network-status');
  const deviceName = document.getElementById('install-device-name');
  const steps = document.getElementById('install-app-steps');
  const ua = navigator.userAgent || '';
  const nativeApp = /\bClassnestAndroid\//.test(ua);
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const android = /Android/.test(ua);
  let displayMode;
  try { displayMode = window.matchMedia('(display-mode: standalone)'); } catch { /* Older browsers keep normal browsing. */ }
  let pendingPrompt = null;
  let accepted = false;
  let prompting = false;
  let previousOffline = false;
  let networkTimer;
  const installed = () => nativeApp || accepted || navigator.standalone === true || displayMode?.matches === true;
  const canRegister = () => !nativeApp && 'serviceWorker' in navigator && window.isSecureContext;

  function refreshControls() {
    const hide = installed() || !canRegister();
    controls.forEach(control => { control.hidden = hide; });
    if (installNow) installNow.hidden = hide || !pendingPrompt;
  }

  function setStatus(message) {
    if (!status) return;
    status.textContent = message;
    status.hidden = !message;
  }

  function renderSteps() {
    if (!deviceName || !steps) return;
    const instructions = ios ? [
      'Open this website in Safari on your iPhone or iPad.',
      'Tap Share, then choose Add to Home Screen.',
      'Keep Open as Web App on if it is shown, then tap Add.',
      'Open Classnest from its new home-screen icon and sign in.'
    ] : android ? [
      'Open this website in Chrome on your Android phone.',
      'Tap the browser menu (⋮), then Install app or Add to Home screen.',
      'Confirm the installation, then open Classnest from its app icon.'
    ] : [
      'In Chrome or Edge, look for the install icon in the address bar or the browser menu.',
      'Choose the option to install Classnest and confirm.',
      'On a phone, follow the Android or iPhone instructions below.'
    ];
    deviceName.textContent = ios ? 'On your iPhone or iPad' : android ? 'On your Android phone' : 'Keep Classnest one tap away';
    steps.replaceChildren(...instructions.map(instruction => {
      const item = document.createElement('li');
      item.textContent = instruction;
      return item;
    }));
  }

  function openGuide() {
    if (!dialog || installed()) return;
    renderSteps();
    setStatus('');
    refreshControls();
    if (!dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }
  }

  function closeGuide() {
    if (!dialog?.open) return;
    if (typeof dialog.close === 'function') dialog.close();
    else dialog.removeAttribute('open');
  }

  async function requestInstall() {
    if (prompting || installed()) return;
    if (!pendingPrompt) { openGuide(); return; }
    const prompt = pendingPrompt;
    pendingPrompt = null;
    prompting = true;
    refreshControls();
    try {
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice?.outcome === 'accepted') { accepted = true; closeGuide(); }
      else if (dialog?.open) setStatus('Installation was not completed. You can try again later from your browser menu.');
    } catch {
      openGuide();
      setStatus('Your browser could not open installation. Follow the steps above to add Classnest.');
    } finally {
      prompting = false;
      refreshControls();
    }
  }

  controls.forEach(control => control.addEventListener('click', requestInstall));
  installNow?.addEventListener('click', requestInstall);
  document.getElementById('close-install-app')?.addEventListener('click', closeGuide);
  document.getElementById('install-app-done')?.addEventListener('click', closeGuide);
  dialog?.addEventListener('click', event => {
    if (event.target !== dialog) return;
    const box = dialog.getBoundingClientRect();
    if (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom) closeGuide();
  });
  window.addEventListener('beforeinstallprompt', event => {
    if (installed()) return;
    event.preventDefault();
    pendingPrompt = event;
    refreshControls();
  });
  window.addEventListener('appinstalled', () => {
    accepted = true;
    pendingPrompt = null;
    closeGuide();
    refreshControls();
  });
  if (displayMode?.addEventListener) displayMode.addEventListener('change', refreshControls);
  else if (displayMode?.addListener) displayMode.addListener(refreshControls);

  function updateConnectivity() {
    if (!networkStatus) return;
    clearTimeout(networkTimer);
    const offline = navigator.onLine === false;
    if (offline) {
      networkStatus.textContent = 'You’re offline. Reconnect to load notes and class updates.';
      networkStatus.hidden = false;
    } else if (previousOffline) {
      networkStatus.textContent = 'Back online. Your connection is ready.';
      networkStatus.hidden = false;
      networkTimer = setTimeout(() => { networkStatus.hidden = true; }, 6000);
    } else networkStatus.hidden = true;
    previousOffline = offline;
  }
  window.addEventListener('online', updateConnectivity);
  window.addEventListener('offline', updateConnectivity);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') updateConnectivity();
  });
  updateConnectivity();
  refreshControls();

  function registerWorker() {
    if (!canRegister()) return;
    navigator.serviceWorker.register('/service-worker.js', {scope: '/', updateViaCache: 'none'}).catch(() => {
      /* Browsing and account actions keep working if a browser blocks workers. */
    });
  }
  if (document.readyState === 'complete') registerWorker();
  else window.addEventListener('load', registerWorker, {once: true});
})();
