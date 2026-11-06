/* Installation UI has no access to accounts, reports or cloud sessions. */
(function () {
  'use strict';
  const PRODUCTION_ORIGIN = 'https://notas-maraba.github.io';
  const PRODUCTION_PATH = '/em-dia-relatorios/';
  let deferredPrompt = null, installed = false, prompting = false;
  const displayMode = window.matchMedia ? window.matchMedia('(display-mode: standalone)') : null;
  function isInstalled() { return installed || !!displayMode?.matches || window.navigator.standalone === true; }
  function refresh() {
    const active = isInstalled();
    document.documentElement.classList.toggle('pwa-installed', active);
    document.querySelectorAll('[data-install-app]').forEach(button => { button.hidden = active; });
  }
  function instructions() {
    const userAgent = window.navigator.userAgent || '';
    const ios = /iPhone|iPad|iPod/i.test(userAgent) || (window.navigator.platform === 'MacIntel' && window.navigator.maxTouchPoints > 1);
    if (ios) return '<ol><li>Abra este endereço no <strong>Safari</strong>.</li><li>Abra o menu <strong>Compartilhar</strong> e escolha <strong>Adicionar à Tela de Início</strong>.</li><li>Se aparecer, ative <strong>Abrir como App da Web</strong> e toque em <strong>Adicionar</strong>.</li></ol>';
    if (/Android/i.test(userAgent)) return '<ol><li>Abra este endereço no <strong>Chrome</strong>.</li><li>Toque no menu <strong>⋮</strong> e escolha <strong>Instalar aplicativo</strong> ou <strong>Adicionar à tela inicial</strong>.</li><li>Confirme a instalação no navegador.</li></ol>';
    return '<ol><li>Abra este endereço no <strong>Chrome</strong> ou no <strong>Edge</strong>.</li><li>Procure <strong>Instalar Em dia</strong> na barra de endereço ou no menu de aplicativos do navegador.</li><li>Confirme a instalação.</li></ol>';
  }
  function showInstructions() {
    const dialog = document.getElementById('install-dialog');
    if (!dialog) return;
    dialog.innerHTML = '<div class="modal-wrap install-help"><header><div class="grow"><h2 id="install-title">Instalar o Em dia</h2><p>Abra o sistema pela tela inicial do aparelho.</p></div><button type="button" class="icon-btn" data-install-close aria-label="Fechar instruções de instalação">×</button></header><div class="modal-body">' + instructions() + '<p class="help">Se a opção não aparecer neste navegador, siga os passos no Chrome ou no Safari. Entre com internet uma primeira vez para preparar os dados neste aparelho. Depois, salve sem conexão e sincronize ao reabrir o aplicativo com internet. Criação de acessos e transferências exigem conexão.</p></div><footer><button type="button" class="btn primary" data-install-close>Entendi</button></footer></div>';
    if (!dialog.open) dialog.showModal();
  }
  async function install() {
    if (isInstalled() || prompting) return;
    if (!deferredPrompt) { showInstructions(); return; }
    const event = deferredPrompt; deferredPrompt = null; prompting = true;
    try {
      // Invoke synchronously inside the user's click, before the first await.
      await event.prompt();
      await event.userChoice;
    } catch (_) { showInstructions(); }
    finally { prompting = false; }
  }
  window.addEventListener('beforeinstallprompt', event => {
    event.preventDefault();
    if (!isInstalled()) deferredPrompt = event;
    refresh();
  });
  window.addEventListener('appinstalled', () => {
    installed = true; deferredPrompt = null;
    const dialog = document.getElementById('install-dialog');
    if (dialog?.open) dialog.close();
    refresh();
  });
  document.addEventListener('click', event => {
    if (event.target?.closest?.('[data-install-close]')) { event.preventDefault(); document.getElementById('install-dialog')?.close(); return; }
    if (event.target?.closest?.('[data-install-app]')) { event.preventDefault(); install(); }
  });
  displayMode?.addEventListener?.('change', refresh);
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh, {once: true}); else refresh();

  function registerShell() {
    // Local previews may inject a seed. Cache only the unmodified public site.
    if (window.EMDIA_LOCAL_CONFIG || window.location.origin !== PRODUCTION_ORIGIN ||
      ![PRODUCTION_PATH, PRODUCTION_PATH + 'index.html'].includes(window.location.pathname) ||
      !('serviceWorker' in window.navigator)) return;
    window.navigator.serviceWorker.register(PRODUCTION_PATH + 'sw.js', {scope: PRODUCTION_PATH, updateViaCache: 'none'})
      .catch(() => { /* Installation remains optional; cloud data is unaffected. */ });
  }
  if (document.readyState === 'complete') registerShell(); else window.addEventListener('load', registerShell, {once: true});
})();
