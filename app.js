// ===== App State =====
const AppState = {
  currentTab: 'score',
  settings: {
    theme: 'light',
    fontSize: 'medium',
    language: 'zh-TW',
    bgm: true,
    sfx: true,
  },
  players: [],
  scoreOptions: [],
  scriptVersion: '',
  sheetUrl: '',
  isOnline: navigator.onLine,
  connectionStatus: 'unknown',
  pendingCount: 0,
  refreshToken: 0,

  // Score page state
  score: { landlord: '', farmer1: '', farmer2: '', selectedScore: null },
  lastCombo: null,
  undoInfo: null,
  undoTimer: null,
  undoCountdownTimer: null,
  undoCountdown: 0,

  // History page state
  history: { games: [], offset: 0, hasMore: true, loading: false, searchQuery: '', dateFrom: '', dateTo: '' },

  // Stats page state
  stats: { range: '本回合', data: [], loading: false, historyGames: [], selectedPlayers: [], loadingHistory: false },
};

const APP_VERSION = 'v2.0.59';
const GOOGLE_CLIENT_ID = '816020476016-r670uelh69npagn3hj7cu5odd2sv0s2u.apps.googleusercontent.com';
const UNDO_WINDOW_MS = 60000;
const DEFAULT_SELECTED_PLAYERS = ['P', 'HK', 'E', 'L', '7C', 'T', 'A'];
const STATS_RANGES = ['本回合', '所有局数', '最近100局', '最近500局', '最近1000局', '最近参与的1000局'];

// ===== Auth State =====
let authPhase = 'splash'; // splash, login, checking, authorized, denied, check_failed

// ===== Initialization =====
async function onReady() {
  if (window._fllInitDone) return;
  window._fllInitDone = true;
  loadSettings();
  applyFontScale();
  updateTabLabels();

  window.addEventListener('online', () => {
    AppState.isOnline = true;
    delete AppState._tabRenderedToken[AppState.currentTab];
    renderTab(AppState.currentTab);
    // Auto-sync on network recovery (matching APK)
    if (authPhase === 'authorized') {
      performHealthCheck();
    }
  });
  window.addEventListener('offline', () => { AppState.isOnline = false; delete AppState._tabRenderedToken[AppState.currentTab]; renderTab(AppState.currentTab); });

  // Start splash screen
  authPhase = 'splash';
  showAuthGate();

  // After 2s splash, check cached auth
  setTimeout(async () => {
    const cachedEmail = API.getCachedAuthEmail();
    if (cachedEmail) {
      // Have cached auth - show checking then authorize
      API.setAuthEmail(cachedEmail);
      authPhase = 'checking';
      showAuthContent_Checking(cachedEmail);
      try {
        const result = await API.checkSheetAccess(cachedEmail);
        if (result.hasAccess) {
          API.saveAuthData(cachedEmail, result.role);
          await transitionToAuthorized();
        } else {
          authPhase = 'denied';
          showAuthContent_Denied(cachedEmail);
        }
      } catch (err) {
        // Network error - use cached auth anyway
        console.warn('[Auth] Check failed, using cached auth:', err);
        await transitionToAuthorized();
      }
    } else {
      // No cached auth - show login
      authPhase = 'login';
      showAuthContent_Login();
    }
  }, 2000);
}

// Auto-call: handle both cases (DOM already loaded or not yet)
console.log('[FLL] readyState:', document.readyState, 'onReady:', typeof onReady);
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onReady);
} else {
  onReady().catch(e => console.error('[FLL] onReady error:', e));
}

async function initApp() {
  AppState.lastCombo = API.getLastCombo();
  AppState.pendingCount = API.getPendingSubmissions().length;
  updatePendingBadge();

  try {
    const params = await API.fetchParams();
    AppState.players = params.players;
    AppState.scoreOptions = params.scoreOptions;
    AppState.scriptVersion = params.version;
    AppState.connectionStatus = 'normal';
    AppState.isOnline = true;
  } catch {
    AppState.connectionStatus = 'failed';
  }

  renderCurrentTab();

  // Preload data in background so other tabs load instantly
  preloadAllData();
}

async function preloadAllData() {
  if (!API.getAuthEmail()) return;

  const hasCache = API.hasFullCache();

  if (hasCache) {
    // Incremental load: only fetch latest round stats + first page of history
    console.log('[Preload] Cache exists, loading latest round only...');
    try {
      const [historyPage, statsRound] = await Promise.all([
        API.fetchHistoryPage(0, 200).catch(() => null),
        API.fetchStats('本回合').catch(() => null),
      ]);
      if (historyPage) window._preloadedHistory = historyPage;
      if (statsRound) window._preloadedStatsRound = statsRound;
      // Use cached stats for non-round ranges
      const cachedStatsAll = API.getCachedStats('所有局数');
      if (cachedStatsAll) window._preloadedStatsAll = cachedStatsAll;
      console.log('[Preload] Incremental load complete');
    } catch (err) {
      console.warn('[Preload] Incremental load failed:', err);
    }
  } else {
    // Full load: preload all stats ranges + first page of history
    // History uses lazy loading (200 per page), so we don't preload all 8000+ games
    console.log('[Preload] No cache, performing full data preload...');
    try {
      const STATS_RANGES_TO_CACHE = ['本回合', '所有局数', '最近100局', '最近500局', '最近1000局', '最近参与的1000局'];
      const statsPromises = STATS_RANGES_TO_CACHE.map(r => API.fetchStats(r).catch(() => null));
      const historyPromise = API.fetchHistoryPage(0, 200).catch(() => null);

      const [historyPage, ...allStats] = await Promise.all([historyPromise, ...statsPromises]);

      if (historyPage) window._preloadedHistory = historyPage;

      STATS_RANGES_TO_CACHE.forEach((range, idx) => {
        if (allStats[idx]) {
          if (range === '所有局数') window._preloadedStatsAll = allStats[idx];
          if (range === '本回合') window._preloadedStatsRound = allStats[idx];
        }
      });

      API.markFullCacheComplete();
      console.log('[Preload] Full data preload + cache complete');
    } catch (err) {
      console.warn('[Preload] Full data preload failed:', err);
    }
  }
}

async function performHealthCheck() {
  if (!API.getAuthEmail()) return;
  try {
    const result = await API.testConnectionWithLatency();
    if (result.ok) {
      AppState.connectionStatus = result.latencyMs > 3000 ? 'slow' : 'normal';
      AppState.isOnline = true;
      // Auto-sync pending with global lock to prevent duplicates
      await syncPendingWithLock();
      // Update server status UI if on settings page
      updateServerStatusUI();
    } else {
      AppState.connectionStatus = 'failed';
      AppState.isOnline = false;
    }
  } catch {
    AppState.connectionStatus = 'failed';
    AppState.isOnline = false;
  }
}

// ===== Settings =====
function loadSettings() {
  const saved = API.getSettings();
  AppState.settings = { ...AppState.settings, ...saved };
}

function saveSetting(key, value) {
  AppState.settings[key] = value;
  API.saveSettings(AppState.settings);
  if (key === 'theme') applyTheme();
  if (key === 'fontSize') applyFontScale();
  if (key === 'language') {
    updateTabLabels();
    // Language change invalidates all tab caches
    AppState._tabRenderedToken = {};
  }
  // Always re-render settings page so segmented controls update visually
  renderSettingsPage(document.getElementById('page-settings'));
}

function applyTheme() {
  const theme = AppState.settings.theme;
  let effective = theme;
  if (theme === 'system') {
    effective = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  document.documentElement.setAttribute('data-theme', effective);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = effective === 'dark' ? '#151718' : '#ffffff';
}

function applyFontScale() {
  const scales = { small: 0.85, medium: 1.15, large: 1.35 };
  document.documentElement.style.setProperty('--font-scale', scales[AppState.settings.fontSize] || 1);
}

function updateTabLabels() {
  document.querySelectorAll('.tab-label[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
}

// ===== Tab Navigation =====
// Track last rendered refreshToken per tab to avoid unnecessary re-renders
if (!AppState._tabRenderedToken) AppState._tabRenderedToken = {};

const TAB_ORDER = ['score', 'history', 'stats', 'settings'];

function switchTab(tab, direction) {
  // Only play click SFX when switching via tab bar tap, not swipe
  if (!direction) playSfx('click');
  const prevTab = AppState.currentTab;
  AppState.currentTab = tab;
  // Update tab bar active state
  document.querySelectorAll('.tab-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  // Show/hide page panels with slide transition
  const prevIdx = TAB_ORDER.indexOf(prevTab);
  const nextIdx = TAB_ORDER.indexOf(tab);
  const slideDir = direction || (nextIdx > prevIdx ? 'left' : 'right');
  ['score', 'history', 'stats', 'settings'].forEach(t => {
    const panel = document.getElementById('page-' + t);
    if (!panel) return;
    if (t === tab) {
      panel.classList.remove('hidden');
      panel.style.animation = `slide-in-${slideDir} 0.25s ease-out`;
    } else {
      panel.classList.add('hidden');
      panel.style.animation = '';
    }
  });
  // Only render if data changed or first visit
  const lastToken = AppState._tabRenderedToken[tab];
  if (tab === 'settings' || lastToken === undefined || lastToken !== AppState.refreshToken) {
    renderTab(tab);
  }
}

// ===== Swipe Navigation =====
function setupSwipeNavigation() {
  const pageContent = document.getElementById('page-content');
  if (!pageContent || pageContent._swipeSetup) return;
  pageContent._swipeSetup = true;
  let startX = 0, startY = 0, startTime = 0;
  pageContent.addEventListener('touchstart', (e) => {
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    startTime = Date.now();
  }, { passive: true });
  pageContent.addEventListener('touchend', (e) => {
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    const dt = Date.now() - startTime;
    // Must be horizontal swipe: |dx| > 60px, |dy| < |dx|, within 500ms
    if (Math.abs(dx) > 60 && Math.abs(dy) < Math.abs(dx) && dt < 500) {
      const currentIdx = TAB_ORDER.indexOf(AppState.currentTab);
      if (dx < 0) {
        // Swipe left → next tab (cyclic: last → first)
        const nextIdx = (currentIdx + 1) % TAB_ORDER.length;
        switchTab(TAB_ORDER[nextIdx], 'left');
      } else if (dx > 0) {
        // Swipe right → previous tab (cyclic: first → last)
        const prevIdx = (currentIdx - 1 + TAB_ORDER.length) % TAB_ORDER.length;
        switchTab(TAB_ORDER[prevIdx], 'right');
      }
    }
  }, { passive: true });
}

function renderTab(tab) {
  const container = document.getElementById('page-' + tab);
  if (!container) return;
  switch (tab) {
    case 'score': renderScorePage(container); break;
    case 'history': renderHistoryPage(container); break;
    case 'stats': renderStatsPage(container); break;
    case 'settings': renderSettingsPage(container); break;
  }
  AppState._tabRenderedToken[tab] = AppState.refreshToken;
}

function renderCurrentTab() {
  renderTab(AppState.currentTab);
}

// ===== Toast =====
let toastTimer = null;
function showToast(message, type = 'info') {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.className = `toast ${type}`;
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toast.className = 'toast hidden'; }, 3000);
}

// ===== Pending Badge =====
function updatePendingBadge() {
  const badge = document.getElementById('pending-badge');
  if (!badge) return;
  const count = API.getPendingSubmissions().length;
  AppState.pendingCount = count;
  if (count > 0) {
    badge.textContent = count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

// ===== Auth Gate Functions =====
function showAuthGate() {
  const gate = document.getElementById('auth-gate');
  const mainApp = document.getElementById('main-app');
  if (gate) { gate.classList.remove('hidden', 'fade-out'); }
  if (mainApp) mainApp.classList.add('hidden');
  // Reset logo to center position
  const logoGroup = document.getElementById('auth-logo-group');
  if (logoGroup) { logoGroup.classList.add('auth-logo-center'); logoGroup.classList.remove('auth-logo-shifted'); }
  // Hide content
  const content = document.getElementById('auth-content');
  if (content) { content.classList.add('hidden'); content.classList.remove('visible'); }
}

function showAuthContent_Login() {
  const logoGroup = document.getElementById('auth-logo-group');
  if (logoGroup) { logoGroup.classList.remove('auth-logo-center'); logoGroup.classList.add('auth-logo-shifted'); }
  const content = document.getElementById('auth-content');
  if (!content) return;
  content.innerHTML = `
    <button class="auth-google-btn" id="auth-google-btn" onclick="handleGoogleLogin()">
      <svg width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"/><path fill="#FBBC05" d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"/></svg>
      <span>${t('auth_google_signin')}</span>
    </button>
    <div class="auth-version">${t('auth_app_version')} ${APP_VERSION}</div>
  `;
  content.classList.remove('hidden');
  setTimeout(() => content.classList.add('visible'), 50);
}

function showAuthContent_Checking(email) {
  const logoGroup = document.getElementById('auth-logo-group');
  if (logoGroup) { logoGroup.classList.remove('auth-logo-center'); logoGroup.classList.add('auth-logo-shifted'); }
  const content = document.getElementById('auth-content');
  if (!content) return;
  content.innerHTML = `
    <div class="auth-spinner"></div>
    <div class="auth-status-text">${t('auth_checking') || '正在檢查權限...'}</div>
    <div class="auth-email-text">${email}</div>
  `;
  content.classList.remove('hidden');
  setTimeout(() => content.classList.add('visible'), 50);
}

function showAuthContent_CheckFailed(email, errorMsg) {
  const logoGroup = document.getElementById('auth-logo-group');
  if (logoGroup) { logoGroup.classList.remove('auth-logo-center'); logoGroup.classList.add('auth-logo-shifted'); }
  const content = document.getElementById('auth-content');
  if (!content) return;
  content.innerHTML = `
    <div class="auth-error-text">${errorMsg || t('auth_check_failed') || '無法連接伺服器'}</div>
    <div class="auth-email-text">${email}</div>
    <button class="auth-btn-primary" onclick="retryAuthCheck()">
      <span class="material-icons" style="font-size:20px">refresh</span>
      <span>${t('auth_retry') || '重試'}</span>
    </button>
    <button class="auth-btn-secondary" onclick="handleLogout()">
      <span class="material-icons" style="font-size:20px">logout</span>
      <span>${t('settings_logout') || '登出'}</span>
    </button>
  `;
  content.classList.remove('hidden');
  setTimeout(() => content.classList.add('visible'), 50);
}

function showAuthContent_Denied(email) {
  const logoGroup = document.getElementById('auth-logo-group');
  if (logoGroup) { logoGroup.classList.remove('auth-logo-center'); logoGroup.classList.add('auth-logo-shifted'); }
  const content = document.getElementById('auth-content');
  if (!content) return;
  content.innerHTML = `
    <div class="auth-lock-icon"><span class="material-icons" style="font-size:48px">lock</span></div>
    <div class="auth-user-card">
      <div class="auth-user-card-email">${email}</div>
      <div class="auth-user-card-role">${t('auth_no_access') || '沒有編輯權限'}</div>
    </div>
    <div class="auth-status-text" style="margin-bottom:24px">${t('auth_denied_msg') || '你沒有此 Google Sheet 的編輯權限。請聯繫管理員授權。'}</div>
    <button class="auth-btn-primary" onclick="retryAuthCheck()">
      <span class="material-icons" style="font-size:20px">refresh</span>
      <span>${t('auth_recheck') || '重新檢查'}</span>
    </button>
    <button class="auth-btn-secondary" onclick="handleLogout()">
      <span class="material-icons" style="font-size:20px">swap_horiz</span>
      <span>${t('auth_switch_account') || '切換帳號'}</span>
    </button>
  `;
  content.classList.remove('hidden');
  setTimeout(() => content.classList.add('visible'), 50);
}

async function transitionToAuthorized() {
  authPhase = 'authorized';
  // Show main app behind the gate
  const mainApp = document.getElementById('main-app');
  if (mainApp) mainApp.classList.remove('hidden');
  applyTheme();
  setupSwipeNavigation();
  await initApp();
  // Start server status auto-test countdown (30s cycle)
  runServerTest(); // Initial test immediately
  startServerCountdown();
  // Auto-play BGM if enabled
  if (AppState.settings.bgm) {
    initAudio();
    _bgmAudio.play().catch(() => {});
  }
  // Fade out the auth gate
  const gate = document.getElementById('auth-gate');
  if (gate) {
    gate.classList.add('fade-out');
    setTimeout(() => { gate.classList.add('hidden'); }, 600);
  }
}

// Google Sign-In handler
function handleGoogleLogin() {
  const btn = document.getElementById('auth-google-btn');
  if (btn) btn.disabled = true;

  if (typeof google === 'undefined' || !google.accounts) {
    // GIS not loaded yet, retry after a short delay
    showToast(t('auth_google_signin_loading'), 'info');
    setTimeout(() => {
      if (btn) btn.disabled = false;
      handleGoogleLogin();
    }, 1500);
    return;
  }

  google.accounts.id.initialize({
    client_id: GOOGLE_CLIENT_ID,
    callback: handleGoogleCredentialResponse,
    auto_select: false,
  });

  google.accounts.id.prompt((notification) => {
    if (notification.isNotDisplayed() || notification.isSkippedMoment()) {
      // One Tap not available, use popup
      google.accounts.oauth2.initTokenClient({
        client_id: GOOGLE_CLIENT_ID,
        scope: 'email profile',
        callback: handleGoogleTokenResponse,
      }).requestAccessToken();
    }
  });
}

// Handle Google One Tap credential response (JWT)
function handleGoogleCredentialResponse(response) {
  try {
    const payload = JSON.parse(atob(response.credential.split('.')[1]));
    const email = payload.email;
    // Store Google token expiry (exp is in seconds, convert to ms)
    if (payload.exp) {
      window._googleTokenExp = payload.exp * 1000;
    }
    if (email) {
      proceedWithGoogleEmail(email);
    } else {
      showToast(t('auth_invalid_email'), 'error');
      showAuthContent_Login();
    }
  } catch (err) {
    console.error('[Auth] Failed to decode Google credential:', err);
    showToast(t('auth_check_failed'), 'error');
    showAuthContent_Login();
  }
}

// Handle Google OAuth2 token response (access token)
async function handleGoogleTokenResponse(tokenResponse) {
  if (!tokenResponse || !tokenResponse.access_token) {
    showToast(t('auth_check_failed'), 'error');
    showAuthContent_Login();
    return;
  }
  try {
    const res = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
      headers: { Authorization: 'Bearer ' + tokenResponse.access_token },
    });
    const userInfo = await res.json();
    if (userInfo.email) {
      proceedWithGoogleEmail(userInfo.email);
    } else {
      showToast(t('auth_invalid_email'), 'error');
      showAuthContent_Login();
    }
  } catch (err) {
    console.error('[Auth] Failed to get Google user info:', err);
    showToast(t('auth_check_failed'), 'error');
    showAuthContent_Login();
  }
}

// Common flow after getting email from Google
async function proceedWithGoogleEmail(email) {
  authPhase = 'checking';
  showAuthContent_Checking(email);

  try {
    const result = await API.checkSheetAccess(email.trim());
    if (result.hasAccess) {
      API.setAuthEmail(email.trim());
      API.saveAuthData(email.trim(), result.role, window._googleTokenExp || null);
      window._googleTokenExp = null;
      await transitionToAuthorized();
    } else {
      authPhase = 'denied';
      showAuthContent_Denied(email);
    }
  } catch (err) {
    authPhase = 'check_failed';
    showAuthContent_CheckFailed(email, err.message || t('auth_check_failed') || '無法連接伺服器');
  }
}

async function retryAuthCheck() {
  const authData = API.getAuthData();
  const email = authData.email || API.getAuthEmail();
  if (!email) {
    handleLogout();
    return;
  }
  authPhase = 'checking';
  showAuthContent_Checking(email);
  try {
    const result = await API.checkSheetAccess(email);
    if (result.hasAccess) {
      API.setAuthEmail(email);
      API.saveAuthData(email, result.role);
      await transitionToAuthorized();
    } else {
      authPhase = 'denied';
      showAuthContent_Denied(email);
    }
  } catch (err) {
    authPhase = 'check_failed';
    showAuthContent_CheckFailed(email, err.message);
  }
}

// ===== Picker Modal =====
let pickerCallback = null;

function openPicker(title, items, selectedValue, callback) {
  pickerCallback = callback;
  const titleEl = document.getElementById('picker-title');
  if (titleEl) titleEl.textContent = title;
  const list = document.getElementById('picker-list');
  if (!list) return;

  list.innerHTML = items.map(item => {
    const isScore = typeof item.value === 'number';
    const isSelected = item.value === selectedValue;
    let textClass = 'picker-item-text';
    if (isScore) {
      textClass += ' score';
      if (item.value > 0) textClass += ' score-positive';
      else if (item.value < 0) textClass += ' score-negative';
    }
    const valStr = isScore ? item.value : `'${item.value}'`;
    return `<div class="picker-item ${isSelected ? 'selected' : ''}" onclick="selectPickerItem(${valStr})">
      <span class="${textClass}">${item.label}</span>
      ${isSelected ? '<span class="picker-item-check material-icons">check</span>' : ''}
    </div>`;
  }).join('');
  document.getElementById('picker-modal').classList.remove('hidden');
}

function selectPickerItem(value) {
  playSfx('click');
  if (pickerCallback) pickerCallback(value);
  closePicker();
}

function closePicker(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('picker-modal').classList.add('hidden');
  pickerCallback = null;
}

// ===== SCORE PAGE =====
function renderScorePage(container) {
  const s = AppState.score;
  const farmerScore = s.selectedScore !== null ? -s.selectedScore / 2 : null;
  const pending = API.getPendingSubmissions();

  let scoreClass = 'form-value placeholder';
  if (s.selectedScore !== null) {
    scoreClass = s.selectedScore > 0 ? 'form-value score-positive' : s.selectedScore < 0 ? 'form-value score-negative' : 'form-value score-zero';
  }

  let html = '';

  if (!AppState.isOnline) {
    html += `<div class="offline-banner"><span class="material-icons" style="font-size:16px">cloud_off</span> ${t('offline_banner')}</div>`;
  }

  html += `<h1 class="page-title">${t('score_title')}</h1>`;

  // Quick reuse button
  if (AppState.lastCombo) {
    const reuseHidden = (s.landlord || s.farmer1 || s.farmer2) ? ' hidden' : '';
    html += `<div id="quick-reuse-banner" class="quick-reuse-btn${reuseHidden}" onclick="applyLastCombo()">
      <span class="material-icons">replay</span>
      <span>${t('score_last_game')} ${AppState.lastCombo.landlord} / ${AppState.lastCombo.farmer1} / ${AppState.lastCombo.farmer2}</span>
    </div>`;
  }

  // Input form card — wrapped in a div with id for targeted updates
  html += `<div id="score-form-area">${buildScoreFormHTML(s, scoreClass, farmerScore)}</div>`;

  if (pending.length > 0) {
    html += renderPendingSyncPanel('compact', pending);
  }

  html += `<div class="round-section">
    <h2 class="round-title" style="margin-top:16px">${t('score_latest_round')}</h2>
    <div id="round-summary-content"><div class="loading-spinner"><div class="spinner"></div></div></div>
    <h2 class="round-title" style="margin-top:20px">${t('round_trend_title')}</h2>
    <div id="round-trend-chart" style="margin-top:8px;margin-left:-8px;margin-right:-8px"></div>
  </div>`;

  container.innerHTML = html;
  loadRoundSummary();
}

async function loadRoundSummary() {
  const el = document.getElementById('round-summary-content');
  const chartEl = document.getElementById('round-trend-chart');
  if (!el) return;

  if (!API.getAuthEmail()) {
    el.innerHTML = `<div class="empty-state">${t('score_no_round_data')}</div>`;
    return;
  }

  try {
    const [statsData, historyPage] = await Promise.all([
      API.fetchStats('本回合'),
      API.fetchHistoryPage(0, 200),
    ]);

    const pending = API.getPendingSubmissions();
    const roundStats = overlayPendingOnStats(statsData.filter(s => s.gamesPlayed > 0), pending);

    if (roundStats.length === 0) {
      el.innerHTML = `<div class="empty-state">${t('score_no_round_data')}</div>`;
      return;
    }

    let tableHtml = `<div class="summary-table">
      <div class="summary-header-row">
        <span class="summary-cell summary-cell-name text-muted" style="font-size:calc(13px * var(--font-scale))">${t('stats_header_player')}</span>
        <span class="summary-cell summary-cell-num text-muted" style="font-size:calc(13px * var(--font-scale))">${t('stats_header_total')}</span>
        <span class="summary-cell summary-cell-num text-muted" style="font-size:calc(13px * var(--font-scale))">${t('stats_header_avg')}</span>
        <span class="summary-cell summary-cell-num text-muted" style="font-size:calc(13px * var(--font-scale))">${t('stats_header_winrate')}</span>
      </div>`;

    roundStats.forEach(stat => {
      const scoreColor = stat.totalScore > 0 ? 'text-success' : stat.totalScore < 0 ? 'text-error' : '';
      const scorePrefix = stat.totalScore > 0 ? '+' : '';
      tableHtml += `<div class="summary-row">
        <span class="summary-cell summary-cell-name">
          <span>${stat.name}</span>
          ${stat.hasPendingData ? '<span class="material-icons text-warning" style="font-size:11px">cloud_upload</span>' : ''}
        </span>
        <span class="summary-cell summary-cell-num ${scoreColor}" style="font-weight:700">${scorePrefix}${Math.round(stat.totalScore)}</span>
        <span class="summary-cell summary-cell-num text-muted">${stat.avgScore.toFixed(1)}</span>
        <span class="summary-cell summary-cell-num text-muted">${stat.winRate.toFixed(0)}%</span>
      </div>`;
    });

    tableHtml += '</div>';
    el.innerHTML = tableHtml;

    // Round trend chart
    if (historyPage.data.length >= 2 && chartEl) {
      const SIX_HOURS = 6 * 60 * 60 * 1000;
      let roundEndIdx = historyPage.data.length;
      for (let i = 1; i < historyPage.data.length; i++) {
        const t1 = new Date(historyPage.data[i - 1].timestamp).getTime();
        const t2 = new Date(historyPage.data[i].timestamp).getTime();
        if (t1 - t2 > SIX_HOURS) { roundEndIdx = i; break; }
      }
      const roundGames = mergeWithPending(historyPage.data.slice(0, roundEndIdx), API.getPendingSubmissions());
      if (roundGames.length >= 2) {
        // Only show players who participated in the latest round
        const participatingPlayers = new Set();
        roundGames.forEach(g => {
          if (g.scores) {
            Object.entries(g.scores).forEach(([p, s]) => { if (s !== undefined && s !== 0) participatingPlayers.add(p); });
          } else {
            if (g.landlord) participatingPlayers.add(g.landlord);
            if (g.farmer1) participatingPlayers.add(g.farmer1);
            if (g.farmer2) participatingPlayers.add(g.farmer2);
          }
        });
        const filteredPlayers = historyPage.players.filter(p => participatingPlayers.has(p));
        renderTrendChart(chartEl, roundGames, filteredPlayers.length > 0 ? filteredPlayers : historyPage.players, null);
      }
    }
  } catch {
    el.innerHTML = `<div class="empty-state">${t('score_no_round_data')}</div>`;
  }
}

// Build just the form card + buttons HTML (no round summary)
function buildScoreFormHTML(s, scoreClass, farmerScore) {
  let html = `<div class="card">
    <div class="form-row">
      <div class="half-row" onclick="openPlayerPicker('landlord')">
        <span class="form-label">🎩 ${t('score_landlord')}</span>
        <span class="${s.landlord ? 'form-value' : 'form-value placeholder'}">${s.landlord || t('score_select_short')}</span>
        <span class="chevron">›</span>
      </div>
      <div class="half-divider"></div>
      <div class="half-row" onclick="openScorePicker()">
        <span class="form-label">🎯 ${t('score_score_label')}</span>
        <span class="${scoreClass}">${s.selectedScore !== null ? s.selectedScore : t('score_select_short')}</span>
        <span class="chevron">›</span>
      </div>
    </div>
    <div class="form-row-last">
      <div class="half-row" onclick="openPlayerPicker('farmer1')">
        <span class="form-label-farmer">🐖 ${t('score_farmer1')}</span>
        ${s.farmer1 ? `<button class="swap-btn-inline" onclick="event.stopPropagation(); swapToLandlord('farmer1')"><span class="material-icons">swap_vert</span></button>` : '<div class="swap-placeholder"></div>'}
        <span class="${s.farmer1 ? 'form-value-farmer' : 'form-value-farmer placeholder'}">${s.farmer1 || t('score_select_short')}</span>
        <span class="chevron">›</span>
      </div>
      <div class="half-divider"></div>
      <div class="half-row" onclick="openPlayerPicker('farmer2')">
        <span class="form-label-farmer">🐓 ${t('score_farmer2')}</span>
        ${s.farmer2 ? `<button class="swap-btn-inline" onclick="event.stopPropagation(); swapToLandlord('farmer2')"><span class="material-icons">swap_vert</span></button>` : '<div class="swap-placeholder"></div>'}
        <span class="${s.farmer2 ? 'form-value-farmer' : 'form-value-farmer placeholder'}">${s.farmer2 || t('score_select_short')}</span>
        <span class="chevron">›</span>
      </div>
    </div>
  </div>`;

  if (farmerScore !== null) {
    html += `<div class="farmer-preview">${t('score_farmer_preview')} ${farmerScore}</div>`;
  }

  html += `<div class="button-row">
    <button class="submit-btn" onclick="playSfx('card'); handleSubmit()" ${AppState.score._submitting ? 'disabled' : ''}>
      <span class="material-icons">send</span>
      ${AppState.score._submitting ? t('score_submitting') : t('score_submit')}
    </button>
    <button class="clear-btn" onclick="handleClear()">
      <span class="material-icons">refresh</span>
      ${t('score_reset')}
    </button>
  </div>`;

  return html;
}

// Update only the form area without re-rendering the entire page or re-fetching data
function updateScoreFormUI() {
  const formArea = document.getElementById('score-form-area');
  if (!formArea) { delete AppState._tabRenderedToken['score']; renderTab('score'); return; }

  const s = AppState.score;
  const farmerScore = s.selectedScore !== null ? -s.selectedScore / 2 : null;
  let scoreClass = 'form-value placeholder';
  if (s.selectedScore !== null) {
    scoreClass = s.selectedScore > 0 ? 'form-value score-positive' : s.selectedScore < 0 ? 'form-value score-negative' : 'form-value score-zero';
  }

  formArea.innerHTML = buildScoreFormHTML(s, scoreClass, farmerScore);

  // Also update the quick-reuse banner visibility
  const reuseEl = document.getElementById('quick-reuse-banner');
  if (reuseEl) {
    if (AppState.lastCombo && !s.landlord && !s.farmer1 && !s.farmer2) {
      reuseEl.classList.remove('hidden');
    } else {
      reuseEl.classList.add('hidden');
    }
  }
}

function openPlayerPicker(target) {
  const s = AppState.score;
  const selected = [];
  if (target !== 'landlord' && s.landlord) selected.push(s.landlord);
  if (target !== 'farmer1' && s.farmer1) selected.push(s.farmer1);
  if (target !== 'farmer2' && s.farmer2) selected.push(s.farmer2);
  const available = AppState.players.filter(p => !selected.includes(p));

  const title = target === 'landlord' ? t('score_select_landlord') : target === 'farmer1' ? t('score_select_farmer1') : t('score_select_farmer2');
  openPicker(title, available.map(p => ({ label: p, value: p })), s[target], (val) => {
    AppState.score[target] = val;
    updateScoreFormUI();
  });
}

function openScorePicker() {
  openPicker(t('score_select_score_title'),
    AppState.scoreOptions.map(s => ({ label: String(s), value: s })),
    AppState.score.selectedScore,
    (val) => { AppState.score.selectedScore = Number(val); updateScoreFormUI(); }
  );
}

function swapToLandlord(which) {
  const s = AppState.score;
  if (which === 'farmer1' && s.farmer1) {
    const old = s.landlord; s.landlord = s.farmer1; s.farmer1 = old;
  } else if (which === 'farmer2' && s.farmer2) {
    const old = s.landlord; s.landlord = s.farmer2; s.farmer2 = old;
  }
  s.selectedScore = null;
  updateScoreFormUI();
}

function applyLastCombo() {
  if (!AppState.lastCombo) return;
  AppState.score.landlord = AppState.lastCombo.landlord;
  AppState.score.farmer1 = AppState.lastCombo.farmer1;
  AppState.score.farmer2 = AppState.lastCombo.farmer2;
  AppState.score.selectedScore = null;
  updateScoreFormUI();
}

function handleClear() {
  playSfx('click');
  AppState.score = { landlord: '', farmer1: '', farmer2: '', selectedScore: null };
  updateScoreFormUI();
}

let lastSubmitTime = 0;
async function handleSubmit() {
  const s = AppState.score;
  const now = Date.now();
  if (s._submitting || now - lastSubmitTime < 2000) return;
  lastSubmitTime = now;

  if (!s.landlord || !s.farmer1 || !s.farmer2 || s.selectedScore === null) {
    showToast(t('toast_incomplete_data'), 'error'); return;
  }
  if (s.landlord === s.farmer1 || s.landlord === s.farmer2 || s.farmer1 === s.farmer2) {
    showToast(t('toast_duplicate_players'), 'error'); return;
  }

  s._submitting = true;
  updateScoreFormUI();

  const submitData = { landlord: s.landlord, farmer1: s.farmer1, farmer2: s.farmer2, score: s.selectedScore };

  try {
    if (!AppState.isOnline || AppState.connectionStatus === 'failed') {
      API.addPendingSubmission({ ...submitData, landlordScore: submitData.score });
      updatePendingBadge();
      showToast(t('toast_offline_saved'), 'info');
      startUndoTimer({ ...submitData, isOffline: true, pendingId: API.getPendingSubmissions().slice(-1)[0]?.id });
    } else {
      try {
        const result = await API.submitGame(submitData.landlord, submitData.farmer1, submitData.farmer2, submitData.score);
        playSfx('success');
        showToast(t('toast_submit_success'), 'success');
        AppState.refreshToken++;
        startUndoTimer({ ...submitData, timestamp: result.timestamp });
      } catch (err) {
        API.addPendingSubmission({ ...submitData, landlordScore: submitData.score });
        updatePendingBadge();
        showToast(t('toast_network_error_saved'), 'info');
        startUndoTimer({ ...submitData, isOffline: true, pendingId: API.getPendingSubmissions().slice(-1)[0]?.id });
      }
    }

    const combo = { landlord: submitData.landlord, farmer1: submitData.farmer1, farmer2: submitData.farmer2 };
    AppState.lastCombo = combo;
    API.saveLastCombo(combo);
    AppState.score = { landlord: '', farmer1: '', farmer2: '', selectedScore: null };
  } catch (err) {
    showToast(err.message || t('toast_submit_failed'), 'error');
  } finally {
    s._submitting = false;
    // Force re-render score page to refresh round summary
    delete AppState._tabRenderedToken['score'];
    renderTab('score');
  }
}

// ===== Undo =====
function startUndoTimer(info) {
  clearUndoTimer();
  AppState.undoInfo = info;
  AppState.undoCountdown = Math.round(UNDO_WINDOW_MS / 1000);

  const banner = document.getElementById('undo-banner');
  if (!banner) return;
  renderUndoBanner();
  banner.classList.remove('hidden');

  AppState.undoCountdownTimer = setInterval(() => {
    AppState.undoCountdown--;
    if (AppState.undoCountdown <= 0) hideUndoBanner();
    else updateUndoCountdown();
  }, 1000);

  AppState.undoTimer = setTimeout(() => { hideUndoBanner(); }, UNDO_WINDOW_MS);
}

function renderUndoBanner() {
  const banner = document.getElementById('undo-banner');
  const info = AppState.undoInfo;
  if (!info || !banner) return;

  const isOffline = info.isOffline;
  banner.className = `undo-banner ${isOffline ? 'offline' : 'online'}`;

  const scoreStr = info.score > 0 ? `+${info.score}` : `${info.score}`;
  const pct = (AppState.undoCountdown / Math.round(UNDO_WINDOW_MS / 1000)) * 100;

  banner.innerHTML = `
    <div class="undo-progress" style="width:${pct}%"></div>
    <div class="undo-content" onclick="handleUndo()">
      <span class="material-icons undo-icon">undo</span>
      <span class="undo-text">${t('score_undo')} (${info.landlord} ${scoreStr})</span>
      <span class="undo-countdown">${AppState.undoCountdown}s</span>
    </div>`;
}

function updateUndoCountdown() {
  const banner = document.getElementById('undo-banner');
  if (!banner || banner.classList.contains('hidden')) return;
  const countdown = banner.querySelector('.undo-countdown');
  const progress = banner.querySelector('.undo-progress');
  if (countdown) countdown.textContent = `${AppState.undoCountdown}s`;
  if (progress) progress.style.width = `${(AppState.undoCountdown / Math.round(UNDO_WINDOW_MS / 1000)) * 100}%`;
}

function hideUndoBanner() {
  clearUndoTimer();
  const banner = document.getElementById('undo-banner');
  if (banner) banner.classList.add('hidden');
  AppState.undoInfo = null;
  AppState.undoCountdown = 0;
}

function clearUndoTimer() {
  if (AppState.undoTimer) { clearTimeout(AppState.undoTimer); AppState.undoTimer = null; }
  if (AppState.undoCountdownTimer) { clearInterval(AppState.undoCountdownTimer); AppState.undoCountdownTimer = null; }
}

async function handleUndo() {
  playSfx('click');
  const info = AppState.undoInfo;
  if (!info) return;

  // Show "撤銷中..." on the banner
  const banner = document.getElementById('undo-banner');
  if (banner) {
    const textEl = banner.querySelector('.undo-text');
    const countdownEl = banner.querySelector('.undo-countdown');
    if (textEl) textEl.textContent = t('score_undoing') || '撤銷中...';
    if (countdownEl) countdownEl.style.display = 'none';
  }

  try {
    if (info.isOffline && info.pendingId) {
      API.removePendingSubmission(info.pendingId);
      updatePendingBadge();
    } else if (info.timestamp) {
      await API.deleteLastGame(info.timestamp);
    }
    const scoreStr = info.score > 0 ? `+${info.score}` : `${info.score}`;
    showToast(`${t('toast_undo_success')} (${info.landlord} ${scoreStr})`, 'success');
    AppState.refreshToken++;
    hideUndoBanner();
    // Invalidate all tab caches since data changed
    AppState._tabRenderedToken = {};
    renderTab(AppState.currentTab);
  } catch {
    showToast(t('toast_undo_failed'), 'error');
  }
}

// ===== PENDING SYNC PANEL (matches APK PendingSyncPanel) =====
let _pendingSyncExpanded = false;
let _pendingSyncing = false;

function renderPendingSyncPanel(mode, pending) {
  if (pending.length === 0) {
    if (mode === 'full') {
      return `<div class="settings-card"><div class="settings-row"><span class="settings-row-label">${t('settings_pending_records')}</span><span class="settings-row-value">${t('settings_no_pending')}</span></div></div>`;
    }
    return '';
  }

  const isConnected = AppState.connectionStatus === 'normal' || AppState.connectionStatus === 'slow';
  const panelClass = mode === 'full' ? 'sync-panel-full' : 'sync-panel-compact';

  let html = `<div class="sync-panel ${panelClass}">`;

  // Header row
  html += `<div class="sync-panel-header" onclick="toggleSyncExpanded()">`;
  html += `<div class="sync-panel-header-left">`;
  html += `<span class="material-icons" style="color:var(--warning);font-size:16px">cloud_upload</span>`;
  html += `<span style="color:var(--warning);font-size:calc(13px * var(--font-scale));font-weight:600;margin-left:6px">${pending.length} ${t('score_pending_sync')}</span>`;
  html += `<span class="material-icons" style="color:var(--warning);font-size:18px;margin-left:4px">${_pendingSyncExpanded ? 'keyboard_arrow_up' : 'keyboard_arrow_down'}</span>`;
  html += `<span style="color:var(--muted);font-size:calc(11px * var(--font-scale));margin-left:4px">${_pendingSyncExpanded ? t('sync_panel_hide_details') : t('sync_panel_view_details')}</span>`;
  html += `</div>`;

  // Sync button
  html += `<button class="sync-panel-sync-btn" onclick="event.stopPropagation();handleSyncPending()" ${_pendingSyncing || !isConnected ? 'disabled' : ''}>`;
  if (_pendingSyncing) {
    html += `<span class="spinner" style="width:12px;height:12px;border-width:2px"></span>`;
    html += `<span style="margin-left:4px">${t('sync_panel_syncing')}</span>`;
  } else {
    html += `<span class="material-icons" style="font-size:14px">sync</span>`;
    html += `<span style="margin-left:4px">${t('sync_panel_sync_now')}</span>`;
  }
  html += `</button>`;
  html += `</div>`;

  // Server offline hint
  if (!isConnected) {
    html += `<div class="sync-panel-offline"><span class="material-icons" style="font-size:14px">cloud_off</span><span style="margin-left:6px">${t('sync_panel_server_offline')}</span></div>`;
  }

  // Expanded detail list
  if (_pendingSyncExpanded) {
    html += `<div class="sync-panel-details">`;
    pending.forEach((item, idx) => {
      const time = formatPendingTime(item.timestamp);
      const scoreColor = item.landlordScore > 0 ? 'var(--success)' : item.landlordScore < 0 ? 'var(--error)' : 'var(--foreground)';
      const scorePrefix = item.landlordScore > 0 ? '+' : '';
      html += `<div class="sync-panel-item">`;
      html += `<span class="sync-item-time">${time}</span>`;
      html += `<span class="sync-item-landlord">\u{1F3A9} ${item.landlord}</span>`;
      html += `<span class="sync-item-score" style="color:${scoreColor}">${scorePrefix}${item.landlordScore}</span>`;
      html += `<span class="sync-item-farmers">\u{1F416}${item.farmer1} \u{1F413}${item.farmer2}</span>`;
      html += `</div>`;
    });



    // Force clear
    html += `<button class="sync-panel-force-clear" onclick="event.stopPropagation();forceClearPending()">`;
    html += `<span class="material-icons" style="font-size:14px">delete_sweep</span>`;
    html += `<span style="margin-left:6px">${t('sync_panel_force_clear')}</span>`;
    html += `</button>`;
    html += `</div>`;
  }

  html += `</div>`;
  return html;
}

function formatPendingTime(timestamp) {
  try {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return '--:--:--';
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') + ':' + String(d.getSeconds()).padStart(2, '0');
  } catch { return '--:--:--'; }
}

function toggleSyncExpanded() {
  _pendingSyncExpanded = !_pendingSyncExpanded;
  playSfx('click');
  // Re-render current tab to update the panel
  AppState._tabRenderedToken = {};
  renderTab(AppState.currentTab);
}

async function handleSyncPending() {
  if (_pendingSyncing) return;
  _pendingSyncing = true;
  playSfx('click');
  // Update UI to show syncing state
  AppState._tabRenderedToken = {};
  renderTab(AppState.currentTab);

  try {
    const result = await API.syncPendingSubmissions();
    updatePendingBadge();
    AppState.refreshToken++;
    _pendingSyncing = false;

    if (result.failed > 0) {
      showToast(`${t('settings_sync_result')}: ${result.failed} ${t('settings_sync_failed_suffix')}`, 'error');
    } else {
      showToast(t('toast_sync_success').replace('{count}', result.synced), 'success');
      if (result.synced > 0) _pendingSyncExpanded = false;
    }
    AppState._tabRenderedToken = {};
    renderTab(AppState.currentTab);
  } catch {
    _pendingSyncing = false;
    showToast(t('settings_sync_error'), 'error');
    AppState._tabRenderedToken = {};
    renderTab(AppState.currentTab);
  }
}

// Legacy alias
async function syncPending() { handleSyncPending(); }

// Global sync with lock to prevent duplicate sync calls from concurrent triggers
async function syncPendingWithLock() {
  if (_isSyncing) return;
  const pending = API.getPendingSubmissions();
  if (pending.length === 0) return;
  _isSyncing = true;
  try {
    const syncResult = await API.syncPendingSubmissions();
    updatePendingBadge();
    if (syncResult.synced > 0) {
      AppState.refreshToken++;
      showToast(t('toast_sync_success').replace('{count}', syncResult.synced), 'success');
      AppState._tabRenderedToken = {};
      renderTab(AppState.currentTab);
    }
  } catch (err) {
    console.warn('[Sync] Auto-sync failed:', err);
  } finally {
    _isSyncing = false;
  }
}

function showPendingActions(itemId) {
  const pending = API.getPendingSubmissions();
  const item = pending.find(p => p.id === itemId);
  if (!item) return;

  const action = prompt(
    `${t('pending_action_title')}\n\u{1F3A9} ${item.landlord} (${item.landlordScore > 0 ? '+' : ''}${item.landlordScore})\n\n1 = ${t('pending_action_edit')}\n2 = ${t('pending_action_delete')}\n0 = ${t('score_confirm_cancel')}`,
    '0'
  );

  if (action === '1') {
    editPendingItem(item);
  } else if (action === '2') {
    deletePendingItem(item);
  }
}

function editPendingItem(item) {
  const landlord = prompt(`\u{1F3A9} ${t('score_landlord')}:`, item.landlord);
  if (landlord === null) return;
  const score = prompt(`\u{1F3AF} ${t('score_score_label')}:`, String(item.landlordScore));
  if (score === null) return;
  const farmer1 = prompt(`\u{1F416} ${t('score_farmer1')}:`, item.farmer1);
  if (farmer1 === null) return;
  const farmer2 = prompt(`\u{1F413} ${t('score_farmer2')}:`, item.farmer2);
  if (farmer2 === null) return;

  API.updatePendingSubmission(item.id, {
    landlord: landlord.trim() || item.landlord,
    landlordScore: parseInt(score) || item.landlordScore,
    farmer1: farmer1.trim() || item.farmer1,
    farmer2: farmer2.trim() || item.farmer2,
  });
  updatePendingBadge();
  AppState.refreshToken++;
  AppState._tabRenderedToken = {};
  renderTab(AppState.currentTab);
  showToast('Updated', 'success');
}

function deletePendingItem(item) {
  if (confirm(t('pending_action_delete_confirm'))) {
    API.removePendingSubmission(item.id);
    updatePendingBadge();
    AppState.refreshToken++;
    AppState._tabRenderedToken = {};
    renderTab(AppState.currentTab);
    showToast('Deleted', 'success');
  }
}

// ===== HISTORY PAGE =====
function renderHistoryPage(container) {
  const h = AppState.history;
  let html = '';

  if (!AppState.isOnline) {
    html += `<div class="offline-banner"><span class="material-icons" style="font-size:16px">cloud_off</span> ${t('offline_banner')}</div>`;
  }

  html += `<h1 class="page-title">${t('history_title')}</h1>`;

  const hasDateFilter = h.dateFrom || h.dateTo;
  html += `<div class="history-search">
    <span class="material-icons search-icon">search</span>
    <input class="search-input" type="text" placeholder="${t('history_search_placeholder')}" value="${h.searchQuery}" oninput="updateHistorySearch(this.value)">
    <button class="filter-btn ${hasDateFilter ? 'active' : ''}" onclick="openDateFilter()">
      <span class="material-icons">date_range</span>
    </button>
  </div>`;

  if (hasDateFilter) {
    html += `<div style="margin-bottom:8px;font-size:calc(12px * var(--font-scale));color:var(--primary)">
      ${h.dateFrom ? `${t('history_date_from')} ${h.dateFrom} ` : ''}${h.dateTo ? `${t('history_date_to_prefix')} ${h.dateTo}` : ''}
    </div>`;
  }

  html += '<div id="history-pull-indicator" class="pull-indicator hidden"><div class="spinner" style="width:20px;height:20px;border-width:2px"></div></div>';
  html += '<div id="history-list"></div>';
  html += '<div id="history-footer"></div>';

  container.innerHTML = html;
  setupPullToRefresh(container);
  loadHistory(true);
}

// ===== Pull-to-refresh for history page =====
function setupPullToRefresh(container) {
  // Prevent duplicate event listeners on re-render
  if (container._pullToRefreshSetup) return;
  container._pullToRefreshSetup = true;

  let startY = 0;
  let pulling = false;
  let triggered = false;
  const threshold = 80;

  container.addEventListener('touchstart', (e) => {
    if (container.scrollTop <= 0) {
      startY = e.touches[0].clientY;
      pulling = true;
      triggered = false;
    }
  }, { passive: true });

  container.addEventListener('touchmove', (e) => {
    if (!pulling) return;
    const dy = e.touches[0].clientY - startY;
    if (dy > 10 && container.scrollTop <= 0) {
      const indicator = document.getElementById('history-pull-indicator');
      if (indicator) {
        indicator.classList.remove('hidden');
        indicator.style.height = Math.min(dy * 0.5, 50) + 'px';
      }
      if (dy > threshold) triggered = true;
    }
  }, { passive: true });

  container.addEventListener('touchend', () => {
    const indicator = document.getElementById('history-pull-indicator');
    if (pulling && triggered) {
      if (indicator) {
        indicator.style.height = '40px';
      }
      // Full data refresh: clear caches, re-download everything
      handleRefreshAllData().then(() => {
        if (indicator) indicator.classList.add('hidden');
      });
    } else {
      if (indicator) indicator.classList.add('hidden');
    }
    pulling = false;
    triggered = false;
  }, { passive: true });
}

async function loadHistory(reset = false) {
  const h = AppState.history;
  if (h.loading) return;

  if (reset) { h.games = []; h.offset = 0; h.hasMore = true; }
  if (!h.hasMore && !reset) return;

  h.loading = true;
  const footerEl = document.getElementById('history-footer');
  if (footerEl) footerEl.innerHTML = `<div class="loading-spinner"><div class="spinner"></div><span style="color:var(--muted);font-size:14px;margin-left:8px">${t('common_loading')}</span></div>`;

  try {
    const batchSize = h.offset === 0 ? 200 : 100;
    const result = await API.fetchHistoryPage(h.offset, batchSize);

    let games = result.data;

    if (h.offset === 0) {
      games = mergeWithPending(games, API.getPendingSubmissions());
    }

    h.games = reset ? games : [...h.games, ...games];
    h.offset += result.data.length;
    h.hasMore = result.hasMore;

    renderHistoryList();
  } catch {
    if (footerEl) footerEl.innerHTML = `<div class="history-footer clickable" onclick="loadHistory(true)">${t('history_load_failed_retry')}</div>`;
  } finally {
    h.loading = false;
  }
}

// ===== Round Grouping (12-hour gap) =====
const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

function parseTimestamp(ts) {
  if (ts instanceof Date) return ts;
  const match = String(ts).match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
  if (match) {
    return new Date(parseInt(match[1]), parseInt(match[2]) - 1, parseInt(match[3]),
      parseInt(match[4]), parseInt(match[5]), parseInt(match[6]));
  }
  const match2 = String(ts).match(/(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{1,2})/);
  if (match2) {
    return new Date(parseInt(match2[1]), parseInt(match2[2]) - 1, parseInt(match2[3]),
      parseInt(match2[4]), parseInt(match2[5]), 0);
  }
  return new Date(ts);
}

function formatDateYMD(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatTimeHMS(ts) {
  const date = parseTimestamp(ts);
  if (isNaN(date.getTime())) return '';
  const h = String(date.getHours()).padStart(2, '0');
  const mi = String(date.getMinutes()).padStart(2, '0');
  const s = String(date.getSeconds()).padStart(2, '0');
  return `${h}:${mi}:${s}`;
}

function identifyGameRoles(scores) {
  const entries = Object.entries(scores || {});
  if (entries.length === 0) return { landlord: null, farmers: [] };
  let landlord = null;
  const farmers = [];
  const scoreCounts = {};
  for (const [name, score] of entries) {
    if (!scoreCounts[score]) scoreCounts[score] = [];
    scoreCounts[score].push(name);
  }
  for (const [scoreStr, names] of Object.entries(scoreCounts)) {
    const score = Number(scoreStr);
    if (names.length === 1) {
      landlord = { name: names[0], score };
    } else {
      for (const name of names) farmers.push({ name, score });
    }
  }
  if (!landlord && entries.length > 0) {
    entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    landlord = { name: entries[0][0], score: entries[0][1] };
    for (let i = 1; i < entries.length; i++) farmers.push({ name: entries[i][0], score: entries[i][1] });
  }
  return { landlord, farmers };
}

function groupIntoRounds(records, hideLastRound) {
  if (records.length === 0) return [];
  const gamesUnit = t('history_games_unit');
  const currentRoundLabel = t('score_this_round');
  const result = [];
  let currentRound = [];
  let roundStartTime = null;

  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    const currentTime = parseTimestamp(record.timestamp);
    if (i === 0) {
      currentRound = [record];
      roundStartTime = currentTime;
    } else {
      const prevTime = parseTimestamp(records[i - 1].timestamp);
      const timeDiff = prevTime.getTime() - currentTime.getTime();
      if (timeDiff >= TWELVE_HOURS_MS) {
        if (currentRound.length > 0 && roundStartTime) {
          result.push({
            id: `round-${result.length}`,
            title: formatDateYMD(roundStartTime),
            subtitle: `${currentRound.length} ${gamesUnit}`,
            games: currentRound,
            gameCount: currentRound.length,
          });
        }
        currentRound = [record];
        roundStartTime = currentTime;
      } else {
        currentRound.push(record);
      }
    }
  }
  if (currentRound.length > 0 && roundStartTime) {
    result.push({
      id: `round-${result.length}`,
      title: formatDateYMD(roundStartTime),
      subtitle: `${currentRound.length} ${gamesUnit}`,
      games: currentRound,
      gameCount: currentRound.length,
    });
  }
  // Removed hideLastRound logic - always show all rounds
  // Mark first round as current if recent
  if (result.length > 0) {
    const firstRoundTime = parseTimestamp(result[0].games[0].timestamp);
    if (Date.now() - firstRoundTime.getTime() < TWELVE_HOURS_MS) {
      result[0].title = currentRoundLabel;
    }
  }
  return result;
}

// Track which rounds are expanded
if (!AppState.expandedRounds) AppState.expandedRounds = new Set();

function toggleRound(roundId) {
  if (AppState.expandedRounds.has(roundId)) {
    AppState.expandedRounds.delete(roundId);
  } else {
    AppState.expandedRounds.add(roundId);
  }
  renderHistoryList();
}

function renderHistoryList() {
  const listEl = document.getElementById('history-list');
  const footerEl = document.getElementById('history-footer');
  if (!listEl) return;

  let games = [...AppState.history.games];
  const h = AppState.history;

  // Apply date filter
  if (h.dateFrom) {
    const from = new Date(h.dateFrom).getTime();
    games = games.filter(g => new Date(g.timestamp).getTime() >= from);
  }
  if (h.dateTo) {
    const to = new Date(h.dateTo + 'T23:59:59').getTime();
    games = games.filter(g => new Date(g.timestamp).getTime() <= to);
  }

  // Apply search filter
  if (h.searchQuery) {
    const q = h.searchQuery.toLowerCase();
    games = games.filter(g => {
      if (g.scores) return Object.keys(g.scores).some(name => name.toLowerCase().includes(q));
      if (g.landlord && g.landlord.toLowerCase().includes(q)) return true;
      if (g.farmer1 && g.farmer1.toLowerCase().includes(q)) return true;
      if (g.farmer2 && g.farmer2.toLowerCase().includes(q)) return true;
      return false;
    });
  }

  if (games.length === 0) {
    listEl.innerHTML = `<div class="empty-state">${t('history_no_records')}</div>`;
    if (footerEl) footerEl.innerHTML = '';
    return;
  }

  // Group into rounds (never hide last round - we want to show all loaded data)
  const rounds = groupIntoRounds(games, false);

  // Auto-expand latest round on first render
  if (AppState._historyFirstRender !== false && rounds.length > 0) {
    AppState.expandedRounds.add(rounds[0].id);
    AppState._historyFirstRender = false;
  }

  let html = '';
  for (const round of rounds) {
    const isExpanded = AppState.expandedRounds.has(round.id);
    const chevronIcon = isExpanded ? 'expand_more' : 'chevron_right';

    html += `<div class="round-header" onclick="toggleRound('${round.id}')">
      <div class="round-header-left">
        <span class="material-icons round-chevron">${chevronIcon}</span>
        <span class="round-title">${round.title}</span>
      </div>
      <span class="round-subtitle">${round.subtitle}</span>
    </div>`;

    if (isExpanded) {
      html += `<div class="round-games">`;
      round.games.forEach(game => {
        const timeStr = formatTimeHMS(game.timestamp);
        const isPending = game.isPending === true;
        const { landlord, farmers } = identifyGameRoles(game.scores);

        const renderPlayerCell = (name, score) => {
          const scoreColor = score > 0 ? 'positive' : score < 0 ? 'negative' : '';
          const scoreStr = (score > 0 ? '+' : '') + score;
          return `<span class="game-row-player">
            <span class="game-row-player-name">${name}</span>
            <span class="game-row-player-score ${scoreColor}">${scoreStr}</span>
          </span>`;
        };

        html += `<div class="game-row${isPending ? ' pending' : ''}">
          <span class="game-row-time${isPending ? ' pending-time' : ''}">${isPending ? '<span class="material-icons" style="font-size:10px;margin-right:2px;color:var(--warning)">cloud_upload</span>' : ''}${timeStr}</span>
          ${landlord ? renderPlayerCell(landlord.name, landlord.score) : '<span class="game-row-player"></span>'}
          ${farmers.length > 0 ? renderPlayerCell(farmers[0].name, farmers[0].score) : '<span class="game-row-player"></span>'}
          ${farmers.length > 1 ? renderPlayerCell(farmers[1].name, farmers[1].score) : '<span class="game-row-player"></span>'}
        </div>`;
      });
      html += `</div>`;
    }
  }

  listEl.innerHTML = html;

  if (footerEl) {
    if (h.hasMore) {
      footerEl.innerHTML = `<div class="history-footer clickable" onclick="loadHistory(false)">${t('history_load_more')}</div>`;
    } else {
      footerEl.innerHTML = `<div class="history-footer">${t('history_loaded_all')} ${games.length} ${t('history_games_unit')}</div>`;
    }
  }

  // Set up infinite scroll using IntersectionObserver on the footer
  setupInfiniteScroll();
}

// ===== Infinite Scroll for History =====
let _historyObserver = null;
function setupInfiniteScroll() {
  const footerEl = document.getElementById('history-footer');
  const historyPanel = document.getElementById('page-history');
  if (!footerEl || !historyPanel) return;

  // Clean up previous observer
  if (_historyObserver) {
    _historyObserver.disconnect();
    _historyObserver = null;
  }

  const h = AppState.history;
  if (!h.hasMore) return;

  // Use IntersectionObserver to detect when footer becomes visible
  _historyObserver = new IntersectionObserver((entries) => {
    const entry = entries[0];
    if (entry && entry.isIntersecting) {
      const h = AppState.history;
      if (!h.loading && h.hasMore) {
        loadHistory(false);
      }
    }
  }, {
    root: historyPanel,
    rootMargin: '0px 0px 200px 0px', // trigger 200px before footer is visible
    threshold: 0
  });

  _historyObserver.observe(footerEl);
}

function updateHistorySearch(query) {
  AppState.history.searchQuery = query;
  renderHistoryList();
}

function openDateFilter() {
  const h = AppState.history;
  const modal = document.getElementById('date-modal');
  const inner = document.getElementById('date-modal-inner');
  if (!modal || !inner) return;

  inner.innerHTML = `
    <div class="date-filter-title">${t('history_date_filter_title')}</div>
    <div class="date-presets">
      <button class="date-preset-btn" onclick="applyDatePreset('today')">${t('history_preset_today')}</button>
      <button class="date-preset-btn" onclick="applyDatePreset('week')">${t('history_preset_this_week')}</button>
      <button class="date-preset-btn" onclick="applyDatePreset('month')">${t('history_preset_this_month')}</button>
      <button class="date-preset-btn" onclick="applyDatePreset('7days')">${t('history_preset_last_7_days')}</button>
    </div>
    <div class="date-inputs">
      <div class="date-input-row">
        <span class="date-input-label">${t('history_date_from')}</span>
        <input class="date-input" type="date" id="date-from" value="${h.dateFrom}">
      </div>
      <div class="date-input-row">
        <span class="date-input-label">${t('history_date_to')}</span>
        <input class="date-input" type="date" id="date-to" value="${h.dateTo}">
      </div>
    </div>
    <div class="date-actions">
      <button class="date-action-btn clear" onclick="clearDateFilter()">${t('history_date_clear')}</button>
      <button class="date-action-btn confirm" onclick="applyDateFilter()">${t('history_date_confirm')}</button>
    </div>`;
  modal.classList.remove('hidden');
}

function closeDateModal(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('date-modal').classList.add('hidden');
}

function applyDatePreset(preset) {
  const now = new Date();
  let from = '', to = '';
  const fmt = d => d.toISOString().split('T')[0];
  switch (preset) {
    case 'today': from = to = fmt(now); break;
    case 'week': {
      const day = now.getDay();
      const monday = new Date(now);
      monday.setDate(now.getDate() - (day === 0 ? 6 : day - 1));
      from = fmt(monday); to = fmt(now); break;
    }
    case 'month': from = fmt(new Date(now.getFullYear(), now.getMonth(), 1)); to = fmt(now); break;
    case '7days': from = fmt(new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)); to = fmt(now); break;
  }
  const fromEl = document.getElementById('date-from');
  const toEl = document.getElementById('date-to');
  if (fromEl) fromEl.value = from;
  if (toEl) toEl.value = to;
}

function applyDateFilter() {
  const fromEl = document.getElementById('date-from');
  const toEl = document.getElementById('date-to');
  AppState.history.dateFrom = fromEl ? fromEl.value : '';
  AppState.history.dateTo = toEl ? toEl.value : '';
  document.getElementById('date-modal').classList.add('hidden');
  loadHistory(true);
}

function clearDateFilter() {
  AppState.history.dateFrom = '';
  AppState.history.dateTo = '';
  document.getElementById('date-modal').classList.add('hidden');
  loadHistory(true);
}

// ===== STATS PAGE =====
function renderStatsPage(container) {
  const st = AppState.stats;
  const rangeLabels = {
    '本回合': t('stats_range_this_round'), '所有局数': t('stats_range_all'),
    '最近100局': t('stats_range_100'), '最近500局': t('stats_range_500'),
    '最近1000局': t('stats_range_1000'), '最近参与的1000局': t('stats_range_sma1000'),
  };

  let html = '';
  if (!AppState.isOnline) {
    html += `<div class="offline-banner"><span class="material-icons" style="font-size:16px">cloud_off</span> ${t('offline_banner')}</div>`;
  }

  html += `<h1 class="page-title">${t('stats_title')}</h1>`;

  html += '<div class="range-scroll">';
  STATS_RANGES.forEach(range => {
    html += `<button class="range-chip ${range === st.range ? 'active' : ''}" onclick="changeStatsRange('${range}')">${rangeLabels[range] || range}</button>`;
  });
  html += '</div>';

  html += '<div id="stats-content"><div class="loading-spinner"><div class="spinner"></div></div></div>';

  container.innerHTML = html;
  loadStatsData();
}

async function loadStatsData() {
  const st = AppState.stats;
  const contentEl = document.getElementById('stats-content');
  if (!contentEl) return;
  st.loading = true;

  try {
    const limit = st.range === '所有局数' ? 10000 : st.range === '最近1000局' || st.range === '最近参与的1000局' ? 1000 : st.range === '最近500局' ? 500 : st.range === '最近100局' ? 100 : 500;

    // Use cached stats for non-round ranges when available
    let statsData, historyPage;
    const hasCache = API.hasFullCache();
    const isRoundRange = st.range === '本回合';

    if (hasCache && !isRoundRange) {
      const cachedStats = API.getCachedStats(st.range);
      if (cachedStats) {
        statsData = cachedStats;
        console.log('[Stats] Using cached stats for range:', st.range);
      } else {
        statsData = await API.fetchStats(st.range);
      }
    } else {
      statsData = await API.fetchStats(st.range);
    }
    // Always fetch history from API for trend charts
    historyPage = await API.fetchHistoryPage(0, limit);

    const pending = API.getPendingSubmissions();
    st.data = overlayPendingOnStats(statsData, pending);

    let historyGames = historyPage.data;
    if (st.range === '本回合' && historyGames.length > 0) {
      historyGames = filterCurrentRoundGames(historyGames);
    }
    st.historyGames = mergeWithPending(historyGames, pending);

    if (st.selectedPlayers.length === 0 && st.data.length > 0) {
      const available = st.data.map(s => s.name);
      const defaults = DEFAULT_SELECTED_PLAYERS.filter(p => available.includes(p));
      st.selectedPlayers = defaults.length > 0 ? defaults : [st.data[0].name];
    }

    renderStatsContent(contentEl);
  } catch {
    contentEl.innerHTML = `<div class="empty-state">${t('stats_load_failed')}</div>`;
  } finally {
    st.loading = false;
  }
}

function renderStatsContent(contentEl) {
  const st = AppState.stats;
  if (st.data.length === 0) {
    contentEl.innerHTML = `<div class="empty-state">${t('stats_no_data')}</div>`;
    return;
  }

  let html = '<div class="stats-table">';
  html += `<div class="stats-header">
    <span class="stats-cell stats-cell-rank">${t('stats_header_rank')}</span>
    <span class="stats-cell stats-cell-name"><span>${t('stats_header_player')}</span></span>
    <span class="stats-cell stats-cell-score">${t('stats_header_total')}</span>
    <span class="stats-cell stats-cell-avg">${t('stats_header_avg')}</span>
    <span class="stats-cell stats-cell-games">${t('stats_header_games')}</span>
    <span class="stats-cell stats-cell-winrate">${t('stats_header_winrate')}</span>
  </div>`;

  st.data.forEach((item, idx) => {
    const roundedTotal = Math.round(item.totalScore);
    const roundedAvg = (Math.round(item.avgScore * 100) / 100).toFixed(2);
    const isIncomplete = item.isSMA1000Incomplete;
    const scoreColor = isIncomplete ? 'text-muted' : (roundedTotal > 0 ? 'text-success' : roundedTotal < 0 ? 'text-error' : '');
    const scoreText = (roundedTotal > 0 ? '+' : '') + roundedTotal;

    html += `<div class="stats-row ${isIncomplete ? 'incomplete' : ''}">
      <span class="stats-cell stats-cell-rank">${idx + 1}</span>
      <span class="stats-cell stats-cell-name">
        <span>${item.name}</span>
        ${item.hasPendingData ? '<span class="material-icons text-warning" style="font-size:11px">cloud_upload</span>' : ''}
      </span>
      <span class="stats-cell stats-cell-score ${scoreColor}">${scoreText}</span>
      <span class="stats-cell stats-cell-avg">${roundedAvg}</span>
      <span class="stats-cell stats-cell-games">${item.gamesPlayed}</span>
      <span class="stats-cell stats-cell-winrate">${item.winRate.toFixed(0)}%</span>
    </div>`;
  });
  html += '</div>';

  // Charts
  html += '<div class="charts-section">';
  const playerNames = st.data.map(s => s.name);
  const selectedText = st.selectedPlayers.length <= 3
    ? st.selectedPlayers.join(', ')
    : `${st.selectedPlayers.slice(0, 2).join(', ')} +${st.selectedPlayers.length - 2}`;

  html += `<div class="player-selector-row">
    <span class="player-selector-label">${t('stats_select_players')}</span>
    <div class="player-selector-btn" onclick="openStatsPlayerPicker()">
      <span>${selectedText || t('stats_please_select_player')}</span>
      <span class="material-icons">arrow_drop_down</span>
    </div>
  </div>`;

  // Stats trend chart always shows container; the render function handles insufficient data message
  html += `<div class="chart-title">${t('stats_trend_title')}</div>`;
  html += '<div id="stats-trend-chart" class="chart-container" style="margin-left:-16px;margin-right:-16px;width:calc(100% + 32px)"></div>';

  if (st.historyGames.length > 0) {
    html += `<div class="radar-section">
      <div class="chart-title">${t('stats_radar_title')}</div>
      <div id="stats-radar-chart" class="chart-container"></div>
    </div>`;
  }
  html += '</div>';

  contentEl.innerHTML = html;

  setTimeout(() => {
    {
      const trendEl = document.getElementById('stats-trend-chart');
      if (trendEl) renderStatsTrendChart(trendEl, st.historyGames, playerNames, st.selectedPlayers);
    }
    if (st.historyGames.length > 0) {
      const radarEl = document.getElementById('stats-radar-chart');
      if (radarEl) renderRadarChart(radarEl, st.historyGames, playerNames, st.selectedPlayers);
    }
  }, 50);
}

function changeStatsRange(range) {
  playSfx('click');
  AppState.stats.range = range;
  // Force re-render stats page (refreshToken hasn't changed, but range did)
  delete AppState._tabRenderedToken['stats'];
  renderTab('stats');
}

function openStatsPlayerPicker() {
  const modal = document.getElementById('player-picker-modal');
  const inner = document.getElementById('player-picker-inner');
  if (!modal || !inner) return;
  const playerNames = AppState.stats.data.map(s => s.name);

  let html = `<div class="player-picker-title">${t('stats_select_players_multi')}</div>`;
  html += '<div class="player-picker-list">';
  playerNames.forEach(name => {
    const isSelected = AppState.stats.selectedPlayers.includes(name);
    html += `<div class="player-picker-item ${isSelected ? 'selected' : ''}" onclick="toggleStatsPlayer('${name}')">
      <span class="player-picker-item-name">${name}</span>
      ${isSelected ? '<span class="material-icons text-primary" style="font-size:18px">check</span>' : ''}
    </div>`;
  });
  html += '</div>';
  html += `<button class="player-picker-done" onclick="closePlayerPicker()">${t('stats_done')}</button>`;

  inner.innerHTML = html;
  modal.classList.remove('hidden');
}

function toggleStatsPlayer(name) {
  const sp = AppState.stats.selectedPlayers;
  const idx = sp.indexOf(name);
  if (idx >= 0) { if (sp.length > 1) sp.splice(idx, 1); }
  else { sp.push(name); }
  openStatsPlayerPicker();
  const contentEl = document.getElementById('stats-content');
  if (contentEl) renderStatsContent(contentEl);
}

function closePlayerPicker(event) {
  if (event && event.target !== event.currentTarget) return;
  document.getElementById('player-picker-modal').classList.add('hidden');
}

// ===== SETTINGS PAGE =====
function renderSettingsPage(container) {
  const s = AppState.settings;
  const pending = API.getPendingSubmissions();
  const authEmail = API.getAuthEmail();

  let html = `<h1 class="page-title">${t('settings_title')}</h1>`;

  // Display
  html += `<div class="settings-section">
    <div class="settings-section-title">${t('settings_display')}</div>
    <div class="settings-card">
      <div class="settings-row">
        <span class="settings-row-label">${t('settings_theme_mode')}</span>
        <div class="segmented-control">
          <button class="segment-btn ${s.theme === 'system' ? 'active' : ''}" onclick="saveSetting('theme','system')">${t('settings_theme_system')}</button>
          <button class="segment-btn ${s.theme === 'light' ? 'active' : ''}" onclick="saveSetting('theme','light')">${t('settings_theme_light')}</button>
          <button class="segment-btn ${s.theme === 'dark' ? 'active' : ''}" onclick="saveSetting('theme','dark')">${t('settings_theme_dark')}</button>
        </div>
      </div>
      <div class="settings-row">
        <span class="settings-row-label">${t('settings_font_size')}</span>
        <div class="segmented-control">
          <button class="segment-btn ${s.fontSize === 'small' ? 'active' : ''}" onclick="saveSetting('fontSize','small')">${t('settings_font_small')}</button>
          <button class="segment-btn ${s.fontSize === 'medium' ? 'active' : ''}" onclick="saveSetting('fontSize','medium')">${t('settings_font_medium')}</button>
          <button class="segment-btn ${s.fontSize === 'large' ? 'active' : ''}" onclick="saveSetting('fontSize','large')">${t('settings_font_large')}</button>
        </div>
      </div>
      <div class="settings-row">
        <span class="settings-row-label">${t('settings_language')}</span>
        <div class="segmented-control">
          <button class="segment-btn ${s.language === 'zh-TW' ? 'active' : ''}" onclick="saveSetting('language','zh-TW')">繁中</button>
          <button class="segment-btn ${s.language === 'zh-CN' ? 'active' : ''}" onclick="saveSetting('language','zh-CN')">简中</button>
          <button class="segment-btn ${s.language === 'en' ? 'active' : ''}" onclick="saveSetting('language','en')">EN</button>
        </div>
      </div>
    </div>
  </div>`;

  // Audio (moved right after Display, matching APK order)
  html += `<div class="settings-section">
    <div class="settings-section-title">${t('settings_audio')}</div>
    <div class="settings-card">
      <div class="settings-row">
        <div style="flex:1">
          <span class="settings-row-label">${t('settings_bgm')}</span>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" ${AppState.settings.bgm ? 'checked' : ''} onchange="toggleBgm(this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
      <div class="settings-row">
        <div style="flex:1">
          <span class="settings-row-label">${t('settings_sfx')}</span>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" ${AppState.settings.sfx ? 'checked' : ''} onchange="toggleSfx(this.checked)">
          <span class="toggle-slider"></span>
        </label>
      </div>
    </div>
  </div>`;

  // Server Status (countdown when idle, spinner on button when testing)
  const countdownDisplay = _serverTesting ? '' : `<span id="server-countdown" style="color:var(--muted);font-size:calc(12px * var(--font-scale))">${_serverCountdown}s</span>`;
  html += `<div class="settings-section">
    <div class="settings-section-title">${t('settings_server_status')}</div>
    <div class="settings-card">
      <div class="settings-row">
        <div style="display:flex;align-items:center;gap:8px;flex:1">
          <span id="server-status-dot" class="status-dot ${getServerStatusClass()}"></span>
          <span id="server-status-text" style="font-weight:600;color:var(--${AppState.connectionStatus === 'normal' ? 'success' : AppState.connectionStatus === 'slow' ? 'warning' : AppState.connectionStatus === 'failed' ? 'error' : 'muted'})">${getServerStatusText()}</span>
        </div>
        <div style="display:flex;align-items:center;gap:10px">
          ${countdownDisplay}
          <button id="server-test-btn" class="settings-action-btn" onclick="handleManualServerTest()" style="min-width:60px;min-height:32px;height:32px;display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box${_serverTesting ? ';opacity:0.5;cursor:not-allowed' : ''}" ${_serverTesting ? 'disabled' : ''}>${_serverTesting ? '<span class="spinner" style="width:18px;height:18px;border-width:2.5px;display:inline-block"></span>' : t('settings_server_test_button')}</button>
        </div>
      </div>
    </div>
  </div>`;

  // Offline sync
  html += `<div class="settings-section">
    <div class="settings-section-title">${t('settings_offline_sync')}</div>
    ${renderPendingSyncPanel('full', pending)}
  </div>`;

  // Account
  const authData = API.getAuthData();
  html += `<div class="settings-section">
    <div class="settings-section-title">${t('auth_logged_in_as').replace('\uff1a', '').replace(':', '')}</div>
    <div class="settings-card">
      ${authEmail ? `<div class="settings-row">
        <span class="material-icons" style="font-size:24px;color:var(--muted);margin-right:8px">account_circle</span>
        <span class="settings-row-label" style="flex:1">${authEmail}</span>
      </div>` : ''}
      ${authData.role ? `<div class="settings-row">
        <span class="settings-row-label">${t('auth_permission_role')}</span>
        <span class="settings-row-value" style="display:flex;align-items:center;gap:4px">
          <span class="material-icons" style="font-size:16px;color:${authData.role === 'owner' ? 'var(--warning)' : 'var(--success)'}">${authData.role === 'owner' ? 'admin_panel_settings' : 'edit'}</span>
          ${authData.role === 'owner' ? t('auth_role_owner') : t('auth_role_editor')}
        </span>
      </div>` : ''}
      ${authData.verifiedAt ? `<div class="settings-row">
        <span class="settings-row-label">${t('settings_login_validity')}</span>
        <span class="settings-row-value" id="login-validity-text">${getLoginValidityText(authData.verifiedAt)}</span>
      </div>` : ''}
      <div class="settings-row" style="cursor:pointer" onclick="playSfx('click');handleLogout()">
        <span class="settings-row-label text-error" style="display:flex;align-items:center;gap:4px">
          <span class="material-icons" style="font-size:18px">logout</span>
          ${t('auth_relogin_settings')}
        </span>
        <span class="material-icons text-muted" style="font-size:20px">chevron_right</span>
      </div>
    </div>
  </div>`;

  // About
  html += `<div class="settings-section">
    <div class="settings-section-title">${t('settings_about')}</div>
    <div class="settings-card">
      <div class="settings-row">
        <span class="settings-row-label">${t('settings_app_version')}</span>
        <span class="settings-row-value">${APP_VERSION} (Web)</span>
      </div>
      <div class="settings-row">
        <span class="settings-row-label">${t('settings_script_version')}</span>
        <span class="settings-row-value" id="script-version-text">${AppState.scriptVersion || t('common_loading')}</span>
      </div>
      <div class="settings-row">
        <span class="settings-row-label" style="flex:1">${t('settings_about_desc_prefix')}<a id="sheet-url-link" href="#" target="_blank" style="color:var(--primary);text-decoration:underline">${AppState.settings.language === 'en' ? 'cloud' : '雲端'}</a>${t('settings_about_desc_suffix')}</span>
      </div>
    </div>
  </div>`;

  html += '<div style="height:40px"></div>';
  container.innerHTML = html;

  if (!AppState.scriptVersion) {
    API.getScriptVersion().then(v => {
      AppState.scriptVersion = v;
      const el = document.getElementById('script-version-text');
      if (el) el.textContent = v || t('common_unknown');
    });
  }

  // Load sheet URL for the hyperlink
  if (!AppState.sheetUrl) {
    API.getSheetUrl().then(url => {
      if (url) {
        AppState.sheetUrl = url;
        const link = document.getElementById('sheet-url-link');
        if (link) link.href = url;
      }
    });
  } else {
    const link = document.getElementById('sheet-url-link');
    if (link) link.href = AppState.sheetUrl;
  }
}

function getLoginValidityText(verifiedAt) {
  if (!verifiedAt) return t('common_unknown');
  const authData = API.getAuthData();
  const lang = AppState.settings.language;
  const locale = lang === 'en' ? 'en-US' : lang === 'zh-CN' ? 'zh-CN' : 'zh-TW';
  // If we have Google token expiry, show it
  if (authData.tokenExp) {
    const tokenExpMs = parseInt(authData.tokenExp, 10);
    if (tokenExpMs <= Date.now()) {
      // Token expired but auth still valid (no hard expiry)
      return lang === 'en' ? 'Persistent (re-verified on next launch)' : lang === 'zh-CN' ? '持久登入（下次啟動時重新驗證）' : '持久登入（下次啟動時重新驗證）';
    }
    const expStr = new Date(tokenExpMs).toLocaleString(locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return lang === 'en' ? `Token valid until ${expStr}` : `Token 有效至 ${expStr}`;
  }
  // No token exp - show persistent login
  return lang === 'en' ? 'Persistent (until logout)' : lang === 'zh-CN' ? '持久登入（直到登出）' : '持久登入（直到登出）';
}

// ===== Audio =====
let _bgmAudio = null;
let _sfxTap = null;
let _sfxClick = null;
let _sfxCard = null;
let _sfxSuccess = null;

function initAudio() {
  if (!_bgmAudio) {
    _bgmAudio = new Audio('audio/bgm.mp3');
    _bgmAudio.loop = true;
    _bgmAudio.volume = 0.3;
  }
  if (!_sfxTap) {
    _sfxTap = new Audio('audio/sfx_tap.mp3');
    _sfxTap.volume = 0.5;
  }
  if (!_sfxClick) {
    _sfxClick = new Audio('audio/mouse-click.mp3');
    _sfxClick.volume = 0.6;
  }
  if (!_sfxCard) {
    _sfxCard = new Audio('audio/sfx_card.mp3');
    _sfxCard.volume = 0.5;
  }
  if (!_sfxSuccess) {
    _sfxSuccess = new Audio('audio/sfx_success.mp3');
    _sfxSuccess.volume = 0.5;
  }
}

function toggleBgm(enabled) {
  AppState.settings.bgm = enabled;
  API.saveSettings(AppState.settings);
  initAudio();
  if (enabled) {
    _bgmAudio.play().catch(() => {});
  } else {
    _bgmAudio.pause();
  }
}

function toggleSfx(enabled) {
  AppState.settings.sfx = enabled;
  API.saveSettings(AppState.settings);
}

function playSfx(type) {
  if (!AppState.settings.sfx) return;
  initAudio();
  const audio = type === 'click' ? _sfxClick : type === 'tap' ? _sfxTap : type === 'card' ? _sfxCard : _sfxSuccess;
  if (audio) {
    audio.currentTime = 0;
    audio.play().catch(() => {});
  }
}

function getServerStatusText() {
  switch (AppState.connectionStatus) {
    case 'normal': return t('settings_server_normal');
    case 'slow': return t('settings_server_slow');
    case 'failed': return t('settings_server_disconnected');
    case 'testing': return t('settings_server_testing');
    default: return t('settings_server_testing');
  }
}

function getServerStatusClass() {
  switch (AppState.connectionStatus) {
    case 'normal': return 'normal';
    case 'slow': return 'slow';
    case 'failed': return 'disconnected';
    default: return 'testing';
  }
}

// Server auto-test countdown state
let _serverCountdown = 30;
let _serverTesting = false;
let _serverCountdownTimer = null;

// Global sync lock to prevent duplicate sync
let _isSyncing = false;

function startServerCountdown() {
  _serverCountdown = 30;
  if (_serverCountdownTimer) clearInterval(_serverCountdownTimer);
  _serverCountdownTimer = setInterval(() => {
    _serverCountdown--;
    // Update countdown display if on settings page
    const countdownEl = document.getElementById('server-countdown');
    if (countdownEl) countdownEl.textContent = _serverCountdown + 's';
    if (_serverCountdown <= 0) {
      clearInterval(_serverCountdownTimer);
      _serverCountdownTimer = null;
      runServerTest();
    }
  }, 1000);
}

async function runServerTest() {
  _serverTesting = true;
  AppState.connectionStatus = 'testing';
  updateServerStatusUI();

  const result = await API.testConnectionWithLatency();
  AppState.connectionStatus = result.ok ? (result.latencyMs > 3000 ? 'slow' : 'normal') : 'failed';
  AppState.isOnline = result.ok;
  _serverTesting = false;
  updateServerStatusUI();
  startServerCountdown();

  // Auto-sync pending records after successful server test with lock
  if (result.ok) {
    await syncPendingWithLock();
  }
}

function handleManualServerTest() {
  if (_serverTesting) return;
  playSfx('click');
  if (_serverCountdownTimer) clearInterval(_serverCountdownTimer);
  _serverCountdownTimer = null;
  runServerTest();
}

function updateServerStatusUI() {
  const statusText = document.getElementById('server-status-text');
  const statusDot = document.getElementById('server-status-dot');
  const testBtn = document.getElementById('server-test-btn');
  const countdownEl = document.getElementById('server-countdown');

  const statusColor = AppState.connectionStatus === 'normal' ? 'var(--success)'
    : AppState.connectionStatus === 'slow' ? 'var(--warning)'
    : AppState.connectionStatus === 'failed' ? 'var(--error)'
    : 'var(--muted)';

  if (statusText) {
    statusText.textContent = getServerStatusText();
    statusText.style.color = statusColor;
  }
  if (statusDot) statusDot.className = `status-dot ${getServerStatusClass()}`;
  if (testBtn) {
    testBtn.disabled = _serverTesting;
    testBtn.style.opacity = _serverTesting ? '0.5' : '1';
    testBtn.style.cursor = _serverTesting ? 'not-allowed' : 'pointer';
    testBtn.innerHTML = _serverTesting
      ? '<span class="spinner" style="width:18px;height:18px;border-width:2.5px;display:inline-block"></span>'
      : t('settings_server_test_button');
    testBtn.style.minWidth = '60px';
    testBtn.style.minHeight = '32px';
    testBtn.style.height = '32px';
    testBtn.style.display = 'inline-flex';
    testBtn.style.alignItems = 'center';
    testBtn.style.justifyContent = 'center';
    testBtn.style.boxSizing = 'border-box';
  }
  // Show/hide countdown based on testing state
  if (countdownEl) {
    countdownEl.style.display = _serverTesting ? 'none' : '';
  }
}

// Legacy alias for backward compatibility
async function testServerConnection() {
  handleManualServerTest();
}

function forceClearPending() {
  if (confirm(t('sync_panel_force_clear_confirm'))) {
    API.clearPendingSubmissions();
    updatePendingBadge();
    _pendingSyncExpanded = false;
    AppState.refreshToken++;
    showToast(t('sync_panel_cleared'), 'success');
    AppState._tabRenderedToken = {};
    renderTab(AppState.currentTab);
  }
}

async function handleRefreshAllData() {
  // Check if online before clearing cache
  if (!navigator.onLine) {
    showToast(t('common_offline_cannot_refresh') || '離線狀態無法刷新數據', 'warning');
    // Still re-render with existing cached data (don't clear anything)
    return;
  }

  // Online: clear all caches and re-download
  API.clearFullCache();
  // Clear preloaded data
  window._preloadedHistory = null;
  window._preloadedStatsAll = null;
  window._preloadedStatsRound = null;
  // Reset history state
  AppState.history.games = [];
  AppState.history.offset = 0;
  AppState.history.hasMore = true;
  // Reset expanded rounds
  AppState.expandedRounds.clear();
  AppState._historyFirstRender = true;
  // Perform full data load (forces no-cache path)
  await preloadAllData();
  // Re-render all tabs
  AppState._tabRenderedToken = {};
  renderCurrentTab();
}

function handleLogout() {
  API.clearAuth();
  API.clearFullCache();
  // Revoke Google session if GIS is loaded
  if (typeof google !== 'undefined' && google.accounts && google.accounts.id) {
    google.accounts.id.disableAutoSelect();
  }
  // Stop server test timer
  if (_serverCountdownTimer) { clearInterval(_serverCountdownTimer); _serverCountdownTimer = null; }
  // Reset main app
  const mainApp = document.getElementById('main-app');
  if (mainApp) mainApp.classList.add('hidden');
  // Reset tab rendered tokens
  AppState._tabRenderedToken = {};
  // Show splash for 2s then login (matching APK)
  authPhase = 'splash';
  showAuthGate();
  setTimeout(() => {
    authPhase = 'login';
    showAuthContent_Login();
  }, 2000);
}

// ===== CHARTS =====

/**
 * Stats page trend chart: 50-game moving average score per player.
 * Matches APK StatsTrendChart exactly.
 * - X-axis: global game sequence (all games in dataset)
 * - Y-axis: 50-game moving average based ONLY on games the player participated in
 * - Players with fewer than 50 participated games are NOT displayed
 * - During inactive periods, the line stays flat
 * - First 50 participated games per player are skipped (warm-up)
 */
function renderStatsTrendChart(container, games, allPlayers, selectedPlayers) {
  const WINDOW_SIZE = 50;
  const players = selectedPlayers && selectedPlayers.length > 0 ? selectedPlayers : allPlayers;

  // Games come in reverse chronological order (newest first), reverse for chart
  const chronological = [...games].reverse();
  const totalGames = chronological.length;

  if (totalGames === 0) {
    container.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:12px;padding:20px">${t('stats_no_data')}</div>`;
    return;
  }

  // Calculate 50-game moving average for each player
  const playerSeries = {};
  const activePlayers = [];

  players.forEach(p => {
    const recentScores = []; // sliding window buffer
    let gamesPlayed = 0;
    let currentAvg = null;
    const series = [];

    chronological.forEach((g, idx) => {
      let score = undefined;
      if (g.scores && g.scores[p] !== undefined) {
        score = g.scores[p];
      } else if (p === g.landlord) {
        score = g.landlordScore;
      } else if (p === g.farmer1 || p === g.farmer2) {
        score = -g.landlordScore / 2;
      }

      if (score !== undefined) {
        // Player participated in this game
        gamesPlayed++;
        recentScores.push(score);

        // Sliding window: keep only last WINDOW_SIZE scores
        if (recentScores.length > WINDOW_SIZE) {
          recentScores.shift();
        }

        // Only start plotting after WINDOW_SIZE games (stable period)
        if (gamesPlayed >= WINDOW_SIZE) {
          currentAvg = recentScores.reduce((a, b) => a + b, 0) / recentScores.length;
          series.push({ x: idx, y: currentAvg });
        }
      } else {
        // Player did NOT participate - extend flat line if we have a stable average
        if (currentAvg !== null) {
          series.push({ x: idx, y: currentAvg });
        }
      }
    });

    // Only include players with at least WINDOW_SIZE participated games
    if (gamesPlayed >= WINDOW_SIZE && series.length > 0) {
      playerSeries[p] = series;
      activePlayers.push(p);
    }
  });

  if (activePlayers.length === 0) {
    container.innerHTML = `<div style="text-align:center;color:var(--muted);font-size:12px;padding:20px">${t('stats_insufficient_data')}</div>`;
    return;
  }

  // Find min/max across all series for Y-axis
  let minVal = Infinity;
  let maxVal = -Infinity;
  activePlayers.forEach(p => {
    playerSeries[p].forEach(pt => {
      if (pt.y < minVal) minVal = pt.y;
      if (pt.y > maxVal) maxVal = pt.y;
    });
  });

  if (minVal === maxVal) { minVal -= 10; maxVal += 10; }
  const range = maxVal - minVal;
  minVal -= range * 0.1;
  maxVal += range * 0.1;

  const parentW = container.parentElement ? container.parentElement.clientWidth : 0;
  const width = Math.max(container.clientWidth || 360, parentW || 360);
  const height = 300;
  const marginLeft = 50;
  const marginRight = 12;
  const marginTop = 12;
  const marginBottom = 36;
  const chartW = width - marginLeft - marginRight;
  const chartH = height - marginTop - marginBottom;

  const maxX = Math.max(totalGames - 1, 1);
  const xScale = (gameIdx) => marginLeft + (gameIdx / maxX) * chartW;
  const yScale = (v) => marginTop + chartH - ((v - minVal) / (maxVal - minVal)) * chartH;

  // Y-axis ticks
  const yRange = maxVal - minVal;
  const rawStep = yRange / 5;
  const magnitude = Math.pow(10, Math.floor(Math.log10(Math.abs(rawStep) || 1)));
  const step = Math.ceil(rawStep / magnitude) * magnitude || 1;
  const yTicks = [];
  const startTick = Math.ceil(minVal / step) * step;
  for (let tick = startTick; tick <= maxVal; tick += step) {
    yTicks.push(Math.round(tick * 10) / 10);
  }
  if (!yTicks.some(tick => tick === 0) && minVal <= 0 && maxVal >= 0) {
    yTicks.push(0);
    yTicks.sort((a, b) => a - b);
  }

  // X-axis ticks (5 evenly spaced)
  const xTickCount = Math.min(5, totalGames);
  const xTicks = [];
  for (let i = 0; i < xTickCount; i++) {
    const gameIdx = Math.round((i / (xTickCount - 1)) * maxX);
    xTicks.push(gameIdx);
  }

  const colors = ['#1A73E8', '#EF4444', '#22C55E', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1'];

  let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;

  // Horizontal grid lines and Y-axis labels
  yTicks.forEach(tick => {
    const y = yScale(tick);
    if (y < marginTop || y > marginTop + chartH) return;
    const isZero = tick === 0;
    svg += `<line x1="${marginLeft}" y1="${y}" x2="${width - marginRight}" y2="${y}" stroke="var(--border)" stroke-width="${isZero ? 1.5 : 1}" ${isZero ? '' : 'stroke-dasharray="4,3"'}/>`;
    svg += `<text x="${marginLeft - 6}" y="${y + 4}" text-anchor="end" fill="var(--fg)" font-size="10" font-weight="600">${Math.round(tick)}</text>`;
  });

  // X-axis line
  svg += `<line x1="${marginLeft}" y1="${marginTop + chartH}" x2="${width - marginRight}" y2="${marginTop + chartH}" stroke="var(--border)" stroke-width="1.5"/>`;

  // X-axis tick labels
  xTicks.forEach(gameIdx => {
    svg += `<text x="${xScale(gameIdx).toFixed(1)}" y="${marginTop + chartH + 14}" text-anchor="middle" fill="var(--fg)" font-size="10" font-weight="600">${gameIdx + 1}</text>`;
  });

  // Y-axis label (rotated)
  svg += `<text x="12" y="${marginTop + chartH / 2}" text-anchor="middle" fill="var(--fg)" font-size="10" font-weight="600" transform="rotate(-90, 12, ${marginTop + chartH / 2})">${t('trend_y_label')}</text>`;

  // X-axis label
  svg += `<text x="${marginLeft + chartW / 2}" y="${height - 4}" text-anchor="middle" fill="var(--fg)" font-size="10" font-weight="600">${t('trend_x_label')}</text>`;

  // Left border
  svg += `<line x1="${marginLeft}" y1="${marginTop}" x2="${marginLeft}" y2="${marginTop + chartH}" stroke="var(--border)" stroke-width="1.5"/>`;

  // Player lines
  activePlayers.forEach((player, pIdx) => {
    const series = playerSeries[player];
    const color = colors[pIdx % colors.length];
    const points = series.map(pt => `${xScale(pt.x).toFixed(1)},${yScale(pt.y).toFixed(1)}`).join(' ');
    svg += `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="3.5" stroke-linejoin="round" stroke-linecap="round"/>`;
    // End point dot
    const lastPt = series[series.length - 1];
    svg += `<circle cx="${xScale(lastPt.x).toFixed(1)}" cy="${yScale(lastPt.y).toFixed(1)}" r="4" fill="${color}"/>`;
  });

  svg += '</svg>';

  // Legend with dots
  let legend = '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:4px 0;justify-content:center">';
  activePlayers.forEach((player, pIdx) => {
    const color = colors[pIdx % colors.length];
    legend += `<span style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)">
      <span style="width:8px;height:8px;background:${color};border-radius:50%;flex-shrink:0"></span>${player}
    </span>`;
  });
  legend += '</div>';

  container.innerHTML = svg + legend;
}

/**
 * Score page (round) trend chart: cumulative score per game in the current round.
 */
function renderTrendChart(container, games, allPlayers, title, selectedPlayers) {
  if (!games || games.length < 2) return;

  const players = selectedPlayers || allPlayers;
  // Use full available width from container or parent, with minimal margins
  const parentW = container.parentElement ? container.parentElement.clientWidth : 0;
  const width = Math.max(container.clientWidth || 360, parentW || 360);
  const height = 260;
  const padding = { top: 20, right: 20, bottom: 36, left: 40 };
  const chartW = width - padding.left - padding.right;
  const chartH = height - padding.top - padding.bottom;

  const reversedGames = [...games].reverse();
  const playerScores = {};
  players.forEach(p => { playerScores[p] = []; });

  reversedGames.forEach(game => {
    players.forEach(p => {
      let score = 0;
      // Use scores map if available (raw data), otherwise use enriched fields
      if (game.scores && game.scores[p] !== undefined) {
        score = game.scores[p];
      } else if (p === game.landlord) {
        score = game.landlordScore;
      } else if (p === game.farmer1 || p === game.farmer2) {
        score = -game.landlordScore / 2;
      }
      const prev = playerScores[p].length > 0 ? playerScores[p][playerScores[p].length - 1] : 0;
      playerScores[p].push(prev + score);
    });
  });

  let allValues = [];
  players.forEach(p => { allValues = allValues.concat(playerScores[p]); });
  if (allValues.length === 0) return;

  let minVal = Math.min(...allValues);
  let maxVal = Math.max(...allValues);
  if (minVal === maxVal) { minVal -= 10; maxVal += 10; }
  const range = maxVal - minVal;
  minVal -= range * 0.1;
  maxVal += range * 0.1;

  const colors = ['#1A73E8', '#EF4444', '#22C55E', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1'];

  let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;

  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (chartH / gridLines) * i;
    const val = Math.round(maxVal - (maxVal - minVal) * (i / gridLines));
    svg += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--border)" stroke-width="1"/>`;
    svg += `<text x="${padding.left - 6}" y="${y + 4}" text-anchor="end" fill="var(--muted)" font-size="10">${val}</text>`;
  }

  if (minVal < 0 && maxVal > 0) {
    const zeroY = padding.top + chartH * (maxVal / (maxVal - minVal));
    svg += `<line x1="${padding.left}" y1="${zeroY}" x2="${width - padding.right}" y2="${zeroY}" stroke="var(--muted)" stroke-width="1.5" stroke-dasharray="4,4"/>`;
  }

  players.forEach((player, pIdx) => {
    const scores = playerScores[player];
    if (scores.length === 0) return;
    const color = colors[pIdx % colors.length];
    let path = '';
    scores.forEach((val, i) => {
      const x = padding.left + (chartW / Math.max(scores.length - 1, 1)) * i;
      const y = padding.top + chartH * ((maxVal - val) / (maxVal - minVal));
      path += (i === 0 ? 'M' : 'L') + `${x.toFixed(1)},${y.toFixed(1)}`;
    });
    svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>`;
  });

  // X-axis numbers - show every game number when ≤20 games, otherwise use smart ticks
  const totalGames = reversedGames.length;
  if (totalGames <= 20) {
    // Show every game number
    for (let i = 0; i < totalGames; i++) {
      const x = padding.left + (chartW / Math.max(totalGames - 1, 1)) * i;
      svg += `<text x="${x.toFixed(1)}" y="${padding.top + chartH + 16}" text-anchor="middle" fill="var(--muted)" font-size="10">${i + 1}</text>`;
    }
  } else {
    // For larger datasets, show evenly spaced ticks
    const maxTicks = Math.min(totalGames, Math.floor(chartW / 30));
    const step = Math.ceil(totalGames / maxTicks);
    for (let i = 0; i < totalGames; i += step) {
      const x = padding.left + (chartW / Math.max(totalGames - 1, 1)) * i;
      svg += `<text x="${x.toFixed(1)}" y="${padding.top + chartH + 16}" text-anchor="middle" fill="var(--muted)" font-size="10">${i + 1}</text>`;
    }
    // Always show the last number
    if ((totalGames - 1) % step !== 0) {
      const x = padding.left + chartW;
      svg += `<text x="${x.toFixed(1)}" y="${padding.top + chartH + 16}" text-anchor="middle" fill="var(--muted)" font-size="10">${totalGames}</text>`;
    }
  }
  svg += `<text x="${width / 2}" y="${height - 2}" text-anchor="middle" fill="var(--muted)" font-size="10">${t('trend_x_label')}</text>`;
  svg += '</svg>';

  let legend = '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:4px 0;justify-content:center">';
  players.forEach((player, pIdx) => {
    const color = colors[pIdx % colors.length];
    legend += `<span style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--muted)">
      <span style="width:8px;height:8px;background:${color};border-radius:50%;flex-shrink:0"></span>${player}
    </span>`;
  });
  legend += '</div>';

  // Title above chart, legend below chart
  const chartTitle = title ? `<h2 class="round-title">${title}</h2>` : '';
  container.innerHTML = chartTitle + svg + legend;
}

/**
 * Identify the landlord in a 3-player game by score pattern.
 * Matches APK identifyLandlord exactly.
 * The landlord's score equals the negative sum of the two farmers' scores,
 * and the landlord has the highest absolute score.
 */
function identifyLandlord(scores) {
  const entries = Object.entries(scores).filter(([_, s]) => s !== undefined && s !== 0);
  if (entries.length !== 3) return null;
  for (const [name, score] of entries) {
    const others = entries.filter(([n]) => n !== name);
    const othersSum = others.reduce((sum, [_, s]) => sum + s, 0);
    if (Math.abs(score + othersSum) < 0.01) {
      if (Math.abs(score) > Math.abs(others[0][1]) + 0.01) {
        return name;
      }
    }
  }
  entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
  return entries[0][0];
}

/**
 * Calculate radar stats for ALL players, matching APK calculateAllRadarStats exactly.
 * Returns { [player]: { engagement, landlordRate, winRate, volatility, attack, defense, raw* } }
 */
function calculateAllRadarStats(games, playerNames) {
  const result = {};
  if (!games.length || !playerNames.length) return result;

  const playerGameCounts = {};
  playerNames.forEach(p => { playerGameCounts[p] = 0; });

  const rawData = {};
  playerNames.forEach(p => {
    rawData[p] = {
      totalGames: 0, wins: 0,
      landlordGames: 0, landlordWins: 0, landlordTotalScore: 0,
      farmerGames: 0, farmerWins: 0, farmerTotalScore: 0,
      scores: [],
    };
  });

  // Process all games once
  games.forEach(game => {
    const scores = game.scores || {};
    const landlord = identifyLandlord(scores);
    Object.entries(scores).forEach(([p, s]) => {
      if (s === undefined || s === 0) return;
      playerGameCounts[p] = (playerGameCounts[p] || 0) + 1;
      if (!rawData[p]) return;
      const d = rawData[p];
      d.totalGames++;
      d.scores.push(s);
      if (s > 0) d.wins++;
      if (p === landlord) {
        d.landlordGames++;
        d.landlordTotalScore += s;
        if (s > 0) d.landlordWins++;
      } else {
        d.farmerGames++;
        d.farmerTotalScore += s;
        if (s > 0) d.farmerWins++;
      }
    });
  });

  const maxGames = Math.max(...Object.values(playerGameCounts), 1);

  // Compute raw values and normalized values for each player
  const computed = {};
  const attackValues = [];
  const defenseValues = [];

  playerNames.forEach(p => {
    const d = rawData[p];
    if (d.totalGames === 0) return;

    const rawLandlordRate = d.landlordGames / d.totalGames;
    const rawWinRate = d.wins / d.totalGames;
    const rawAttackWinRate = d.landlordGames > 0 ? d.landlordWins / d.landlordGames : 0;
    const rawDefenseWinRate = d.farmerGames > 0 ? d.farmerWins / d.farmerGames : 0;

    // Volatility: rate of big wins/losses relative to this player's own median
    const absScores = d.scores.map(Math.abs).sort((a, b) => a - b);
    const medianAbsScore = absScores[Math.floor(absScores.length / 2)] || 0;
    const bigThreshold = medianAbsScore * 1.5;
    const bigGameCount = d.scores.filter(s => Math.abs(s) > bigThreshold).length;
    const rawVolatility = bigGameCount / d.totalGames;

    const engagement = Math.min(1, d.totalGames / maxGames);
    const landlordRateNorm = Math.min(1, rawLandlordRate / 0.5); // 50% landlord rate = max
    const winRateNorm = rawWinRate;
    const volatilityNorm = Math.min(1, rawVolatility / 0.4); // 40% big games = max

    computed[p] = {
      engagement,
      landlordRate: landlordRateNorm,
      winRate: winRateNorm,
      volatility: volatilityNorm,
      attackWinRate: rawAttackWinRate,
      defenseWinRate: rawDefenseWinRate,
      rawGamesPlayed: d.totalGames,
      rawLandlordRate,
      rawWinRate,
      rawVolatility,
      rawAttackWinRate,
      rawDefenseWinRate,
    };

    if (d.landlordGames > 0) attackValues.push(rawAttackWinRate);
    if (d.farmerGames > 0) defenseValues.push(rawDefenseWinRate);
  });

  // Normalize attack/defense using min-max across all players
  const minMaxNormalize = (value, values) => {
    if (values.length <= 1) return 0.5;
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) return 0.5;
    return 0.1 + ((value - min) / (max - min)) * 0.9;
  };

  playerNames.forEach(p => {
    const c = computed[p];
    if (!c) return;
    result[p] = {
      engagement: c.engagement,
      landlordRate: c.landlordRate,
      winRate: c.winRate,
      volatility: c.volatility,
      attack: minMaxNormalize(c.attackWinRate, attackValues),
      defense: minMaxNormalize(c.defenseWinRate, defenseValues),
      rawGamesPlayed: c.rawGamesPlayed,
      rawLandlordRate: c.rawLandlordRate,
      rawWinRate: c.rawWinRate,
      rawVolatility: c.rawVolatility,
      rawAttackWinRate: c.rawAttackWinRate,
      rawDefenseWinRate: c.rawDefenseWinRate,
    };
  });

  return result;
}

/**
 * Re-normalize radar dimensions for selected players using hybrid absolute/relative blend.
 * Matches APK normalizeForSelectedPlayers exactly.
 */
function normalizeForSelectedPlayers(allStats, selectedPlayers) {
  const RADAR_DIM_KEYS = ['engagement', 'landlordRate', 'winRate', 'volatility', 'attack', 'defense'];
  const active = selectedPlayers.filter(p => allStats[p]);
  if (active.length <= 1) return allStats;

  const zoomWeights = { 2: 0.35, 3: 0.50, 4: 0.60 };
  const zoomWeight = zoomWeights[active.length] || 0.70;

  const dimValues = {};
  RADAR_DIM_KEYS.forEach(key => {
    dimValues[key] = active.map(p => allStats[p][key]);
  });

  const relativeNormalize = (value, values) => {
    const min = Math.min(...values);
    const max = Math.max(...values);
    if (max === min) return 0.55;
    return 0.15 + ((value - min) / (max - min)) * 0.80;
  };

  const lerp = (a, b, t) => a + (b - a) * t;

  const result = { ...allStats };
  active.forEach(p => {
    const s = allStats[p];
    result[p] = {
      ...s,
      engagement: lerp(s.engagement, relativeNormalize(s.engagement, dimValues['engagement']), zoomWeight),
      landlordRate: lerp(s.landlordRate, relativeNormalize(s.landlordRate, dimValues['landlordRate']), zoomWeight),
      winRate: lerp(s.winRate, relativeNormalize(s.winRate, dimValues['winRate']), zoomWeight),
      volatility: lerp(s.volatility, relativeNormalize(s.volatility, dimValues['volatility']), zoomWeight),
      attack: lerp(s.attack, relativeNormalize(s.attack, dimValues['attack']), zoomWeight),
      defense: lerp(s.defense, relativeNormalize(s.defense, dimValues['defense']), zoomWeight),
    };
  });
  return result;
}

function renderRadarChart(container, games, allPlayers, selectedPlayers) {
  if (!games || games.length === 0) return;

  const players = selectedPlayers && selectedPlayers.length > 0 ? selectedPlayers : allPlayers;
  const parentW = container.parentElement ? container.parentElement.clientWidth : 0;
  const size = Math.min(Math.max(container.clientWidth || 360, parentW || 360), 500);
  const cx = size / 2, cy = size / 2;
  const radius = size * 0.36;

  // Calculate stats using APK-matching logic
  const baseStats = calculateAllRadarStats(games, allPlayers);
  // Apply hybrid normalization for selected players
  const allStats = normalizeForSelectedPlayers(baseStats, players);

  const dims = ['engagement', 'landlordRate', 'winRate', 'volatility', 'attack', 'defense'];
  const dimLabels = [
    t('radar_engagement'), t('radar_landlord_rate'), t('radar_win_rate'),
    t('radar_volatility'), t('radar_attack'), t('radar_defense'),
  ];

  const angleStep = (2 * Math.PI) / 6;
  const startAngle = -Math.PI / 2;

  let svg = `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">`;

  for (let level = 1; level <= 5; level++) {
    const r = radius * (level / 5);
    let points = '';
    for (let i = 0; i < 6; i++) {
      const angle = startAngle + angleStep * i;
      points += `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)} `;
    }
    svg += `<polygon points="${points}" fill="none" stroke="var(--border)" stroke-width="1.5"/>`;
  }

  for (let i = 0; i < 6; i++) {
    const angle = startAngle + angleStep * i;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    svg += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--border)" stroke-width="1.5"/>`;
    const lx = cx + (radius + 22) * Math.cos(angle);
    const ly = cy + (radius + 22) * Math.sin(angle);
    const anchor = Math.abs(Math.cos(angle)) < 0.1 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end';
    svg += `<text x="${lx.toFixed(1)}" y="${(ly + 5).toFixed(1)}" text-anchor="${anchor}" fill="var(--fg)" font-size="13" font-weight="600">${dimLabels[i]}</text>`;
  }

  const colors = ['#1A73E8', '#EF4444', '#22C55E', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'];
  players.forEach((player, pIdx) => {
    const stats = allStats[player];
    if (!stats) return;
    const color = colors[pIdx % colors.length];
    let points = '';
    // Use normalized 0-1 values directly for polygon (they are already normalized)
    dims.forEach((d, i) => {
      const val = Math.max(stats[d], 0.05);
      const r = radius * val;
      const angle = startAngle + angleStep * i;
      points += `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)} `;
    });
    svg += `<polygon points="${points}" fill="${color}25" stroke="${color}" stroke-width="3"/>`;
    dims.forEach((d, i) => {
      const val = Math.max(stats[d], 0.05);
      const r = radius * val;
      const angle = startAngle + angleStep * i;
      svg += `<circle cx="${(cx + r * Math.cos(angle)).toFixed(1)}" cy="${(cy + r * Math.sin(angle)).toFixed(1)}" r="5" fill="${color}"/>`;
    });
  });

  svg += '</svg>';

  let legend = '<div style="display:flex;flex-wrap:wrap;gap:10px;padding:8px 0;justify-content:center">';
  players.forEach((player, pIdx) => {
    const color = colors[pIdx % colors.length];
    legend += `<span style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted);font-weight:500">
      <span style="width:10px;height:10px;background:${color};border-radius:50%"></span>${player}
    </span>`;
  });
  legend += '</div>';

  // Radar data table - show each player's 6 dimension RAW values (from baseStats, not normalized)
  let dataTable = '<div style="width:100%;margin-top:12px;padding:0 4px">';
  const dimLabelsTable = [
    t('radar_engagement'), t('radar_landlord_rate'), t('radar_win_rate'),
    t('radar_volatility'), t('radar_attack'), t('radar_defense'),
  ];
  const dimDescs = [
    t('radar_desc_engagement'), t('radar_desc_landlord_rate'), t('radar_desc_win_rate'),
    t('radar_desc_volatility'), t('radar_desc_attack'), t('radar_desc_defense'),
  ];
  players.forEach((player, pIdx) => {
    const stats = baseStats[player]; // Use baseStats for raw values
    if (!stats) return;
    const color = colors[pIdx % colors.length];
    if (players.length > 1) {
      dataTable += `<div style="display:flex;align-items:center;gap:6px;margin-top:16px;margin-bottom:6px;padding-bottom:6px;border-bottom:1.5px solid var(--border)">
        <span style="width:10px;height:10px;background:${color};border-radius:50%;flex-shrink:0"></span>
        <span style="font-size:14px;font-weight:700;color:var(--fg)">${player}</span>
      </div>`;
    }
    const rawKeys = ['rawGamesPlayed', 'rawLandlordRate', 'rawWinRate', 'rawVolatility', 'rawAttackWinRate', 'rawDefenseWinRate'];
    rawKeys.forEach((key, i) => {
      let value = '';
      if (key === 'rawGamesPlayed') value = stats.rawGamesPlayed + t('radar_games_unit');
      else if (key === 'rawLandlordRate') value = (stats.rawLandlordRate * 100).toFixed(1) + '%';
      else if (key === 'rawWinRate') value = (stats.rawWinRate * 100).toFixed(1) + '%';
      else if (key === 'rawVolatility') value = (stats.rawVolatility * 100).toFixed(1) + '%';
      else if (key === 'rawAttackWinRate') value = (stats.rawAttackWinRate * 100).toFixed(1) + '%';
      else if (key === 'rawDefenseWinRate') value = (stats.rawDefenseWinRate * 100).toFixed(1) + '%';
      dataTable += `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0 7px 20px;border-bottom:0.5px solid var(--border)">
        <div style="flex:1;margin-right:8px">
          <div style="font-size:13px;font-weight:600;color:var(--fg)">${dimLabelsTable[i]}</div>
          <div style="font-size:11px;color:var(--muted);margin-top:1px">${dimDescs[i]}</div>
        </div>
        <div style="font-size:14px;font-weight:600;color:var(--fg);font-variant-numeric:tabular-nums;text-align:right;min-width:60px">${value}</div>
      </div>`;
    });
  });
  dataTable += '</div>';

  container.innerHTML = '<div style="display:flex;flex-direction:column;align-items:center">' + svg + legend + '</div>' + dataTable;
}
