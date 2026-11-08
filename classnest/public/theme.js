/* Runs before styles load so a saved preference is applied before first paint. */
(() => {
  'use strict';
  const key = 'classnest-theme';
  const normalize = value => ['light', 'dark', 'system'].includes(value) ? value : 'system';
  let preference = 'system';
  let deviceTheme;
  try { preference = normalize(localStorage.getItem(key)); } catch { /* Private browsing can block storage. */ }
  try { deviceTheme = window.matchMedia('(prefers-color-scheme: dark)'); } catch { /* Use light when unsupported. */ }

  function apply() {
    const theme = preference === 'system' ? (deviceTheme?.matches ? 'dark' : 'light') : preference;
    document.documentElement.dataset.theme = theme;
    document.documentElement.dataset.themePreference = preference;
    const control = document.getElementById('theme');
    if (control) control.value = preference;
    const browserColor = document.querySelector('meta[name="theme-color"]');
    if (browserColor) browserColor.content = theme === 'dark' ? '#151827' : '#f6f7fb';
  }

  function bind() {
    const control = document.getElementById('theme');
    if (!control) return;
    control.value = preference;
    control.addEventListener('change', () => {
      preference = normalize(control.value);
      apply();
      try { localStorage.setItem(key, preference); } catch { /* The selection still works for this visit. */ }
    });
  }

  apply();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind, {once: true});
  else bind();
  const followDevice = () => { if (preference === 'system') apply(); };
  if (deviceTheme?.addEventListener) deviceTheme.addEventListener('change', followDevice);
  else if (deviceTheme?.addListener) deviceTheme.addListener(followDevice);
  window.addEventListener('storage', event => {
    if (event.key !== key && event.key !== null) return;
    preference = normalize(event.newValue);
    apply();
  });
})();
