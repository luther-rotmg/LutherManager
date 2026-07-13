// ═══════════════════════════════════════════════════════
//  FIRST-TIME TUTORIAL — loaded after app.js
// ═══════════════════════════════════════════════════════
(function () {
  var TOTAL_STEPS = 6; // steps 0..5
  var TAB_MAP = { 1: 'home', 2: 'plugins', 3: 'accounts', 4: 'damage' };
  var step = 0;

  var overlay = document.getElementById('tutorial-overlay');
  var nextBtn = document.getElementById('tutorial-next-btn');
  var backBtn = document.getElementById('tutorial-back-btn');
  var skipBtn = document.getElementById('tutorial-skip-btn');
  var dotsEl = document.getElementById('tutorial-dots');
  var emailInput = document.getElementById('tutorial-email');
  var passwordInput = document.getElementById('tutorial-password');
  var statusEl = document.getElementById('tutorial-account-status');

  if (!overlay) return;

  // ── Persistence ──────────────────────────────────────

  function isCompleted() {
    return localStorage.getItem('hive_tutorial_done') === '1';
  }
  function markCompleted() {
    localStorage.setItem('hive_tutorial_done', '1');
  }

  // ── Dots ─────────────────────────────────────────────

  function buildDots() {
    if (!dotsEl) return;
    dotsEl.innerHTML = '';
    for (var i = 0; i < TOTAL_STEPS; i++) {
      var d = document.createElement('div');
      d.className = 'tutorial-dot' + (i === step ? ' active' : i < step ? ' completed' : '');
      dotsEl.appendChild(d);
    }
  }

  // ── Tab switching ────────────────────────────────────

  function switchTab(name) {
    var btn = document.querySelector('.content-tab[data-tab="' + name + '"]');
    if (btn) btn.click();
  }

  // ── Step navigation ──────────────────────────────────

  function showStep(s) {
    step = s;

    overlay.querySelectorAll('.tutorial-step').forEach(function (el) {
      el.classList.toggle('hidden', parseInt(el.getAttribute('data-tutorial-step'), 10) !== s);
    });

    // Welcome & finish screens are centered fullscreen; tab steps show the page behind
    var isSplash = (s === 0 || s === TOTAL_STEPS - 1);
    overlay.classList.toggle('tutorial-centered', isSplash);

    var tab = TAB_MAP[s];
    if (tab) switchTab(tab);

    buildDots();

    if (backBtn) backBtn.classList.toggle('hidden', s === 0);

    if (nextBtn) {
      if (s === 0) nextBtn.textContent = 'Get Started';
      else if (s === 3) nextBtn.textContent = 'Save & Continue';
      else if (s === TOTAL_STEPS - 1) nextBtn.textContent = 'Finish';
      else nextBtn.textContent = 'Next';
    }

    if (skipBtn) skipBtn.classList.toggle('hidden', s === TOTAL_STEPS - 1);

    if (statusEl) {
      statusEl.textContent = '';
      statusEl.className = 'tutorial-account-status';
    }
  }

  // ── Account creation (step 3) ────────────────────────

  function saveAccount() {
    var email = emailInput ? emailInput.value.trim() : '';
    var pw = passwordInput ? passwordInput.value.trim() : '';

    // Both empty = skip
    if (!email && !pw) return true;

    // One filled, one empty
    if (!email || !pw) {
      if (statusEl) {
        statusEl.textContent = 'Please fill in both email and password, or leave both blank to skip.';
        statusEl.className = 'tutorial-account-status error';
      }
      return false;
    }

    // Click the New button to create an account entry
    var newBtn = document.getElementById('accounts-new-btn');
    if (newBtn) newBtn.click();

    // Fill in the real account form fields
    var aliasField = document.getElementById('accounts-alias');
    var emailField = document.getElementById('accounts-email');
    var pwField = document.getElementById('accounts-password');

    if (aliasField) { aliasField.value = email.split('@')[0] || ''; aliasField.dispatchEvent(new Event('input', { bubbles: true })); }
    if (emailField) { emailField.value = email; emailField.dispatchEvent(new Event('input', { bubbles: true })); }
    if (pwField) { pwField.value = pw; pwField.dispatchEvent(new Event('input', { bubbles: true })); }

    // Save
    var saveBtn = document.getElementById('accounts-save-btn');
    if (saveBtn) saveBtn.click();

    if (statusEl) {
      statusEl.textContent = 'Account added!';
      statusEl.className = 'tutorial-account-status success';
    }
    return true;
  }

  // ── Nav handlers ─────────────────────────────────────

  function onNext() {
    if (step === 3 && !saveAccount()) return;
    if (step >= TOTAL_STEPS - 1) { closeTutorial(); return; }
    showStep(step + 1);
  }

  function onBack() {
    if (step > 0) showStep(step - 1);
  }

  function closeTutorial() {
    markCompleted();
    overlay.classList.add('hidden');
    switchTab('home');
  }

  function startTutorial() {
    overlay.classList.remove('hidden');
    showStep(0);
  }

  // ── Wire buttons ─────────────────────────────────────

  if (nextBtn) nextBtn.addEventListener('click', onNext);
  if (backBtn) backBtn.addEventListener('click', onBack);
  if (skipBtn) skipBtn.addEventListener('click', closeTutorial);

  // ── Auto-launch on first visit ───────────────────────

  function isLoggedIn() {
    var disconnectOverlay = document.getElementById('disconnect-overlay');
    return disconnectOverlay && disconnectOverlay.classList.contains('hidden');
  }

  function tryLaunch() {
    if (!isLoggedIn()) return; // don't show tutorial until logged in
    var listEl = document.getElementById('accounts-list');
    var hasAccounts = listEl && listEl.children.length > 0;
    if (!isCompleted() && !hasAccounts) {
      startTutorial();
    }
  }

  // Re-check after login — observe the disconnect overlay for class changes
  var disconnectEl = document.getElementById('disconnect-overlay');
  if (disconnectEl) {
    new MutationObserver(function () {
      if (isLoggedIn() && !isCompleted()) tryLaunch();
    }).observe(disconnectEl, { attributes: true, attributeFilter: ['class'] });
  }

  // Also try on initial load in case already logged in
  setTimeout(tryLaunch, 800);

  // Expose for settings "Replay tutorial" button (app.js calls window._resetTutorial)
  window._resetTutorial = function () {
    localStorage.removeItem('hive_tutorial_done');
    startTutorial();
  };
})();
