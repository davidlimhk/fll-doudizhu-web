// ===== App State =====
const AppState = {
  currentTab: 'score',
  settings: {
    theme: 'light',
    fontSize: 'medium',
    language: 'zh-TW',
    bgm: false,
    sfx: false,
  },
  players: [],
  scoreOptions: [],
  scriptVersion: '',
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

const APP_VERSION = 'v2.0.58';
const UNDO_WINDOW_MS = 60000;
const DEFAULT_SELECTED_PLAYERS = ['P', 'HK', 'E', 'L', '7C', 'T', 'A'];
const STATS_RANGES = ['本回合', '所有局数', '最近100局', '最近500局', '最近1000局', '最近参与的1000局'];

// ===== Initialization =====
async function onReady() {
  if (window._fllInitDone) return;
  window._fllInitDone = true;
  loadSettings();
  applyTheme();
  applyFontScale();
  updateTabLabels();

  // Check cached auth
  const cachedEmail = API.getCachedAuthEmail();
  if (cachedEmail) {
    API.setAuthEmail(cachedEmail);
    hideLoginScreen();
    await initApp();
  } else {
    showLoginScreen();
  }

  window.addEventListener('online', () => { AppState.isOnline = true; renderCurrentTab(); });
  window.addEventListener('offline', () => { AppState.isOnline = false; renderCurrentTab(); });

  // Health check every 30s
  setInterval(performHealthCheck, 30000);
  // Initial health check after 3s
  setTimeout(performHealthCheck, 3000);
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
}

async function performHealthCheck() {
  if (!API.getAuthEmail()) return;
  try {
    const result = await API.testConnectionWithLatency();
    if (result.ok) {
      AppState.connectionStatus = result.latencyMs > 3000 ? 'slow' : 'normal';
      AppState.isOnline = true;
      // Auto-sync pending
      const pending = API.getPendingSubmissions();
      if (pending.length > 0) {
        const syncResult = await API.syncPendingSubmissions();
        updatePendingBadge();
        if (syncResult.synced > 0) {
          AppState.refreshToken++;
          showToast(t('toast_sync_success').replace('{count}', syncResult.synced), 'success');
        }
      }
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
    renderCurrentTab();
  }
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
  const scales = { small: 0.85, medium: 1, large: 1.15 };
  document.documentElement.style.setProperty('--font-scale', scales[AppState.settings.fontSize] || 1);
}

function updateTabLabels() {
  document.querySelectorAll('.tab-label[data-i18n]').forEach(el => {
    el.textContent = t(el.dataset.i18n);
  });
}

// ===== Tab Navigation =====
function switchTab(tab) {
  AppState.currentTab = tab;
  document.querySelectorAll('.tab-item').forEach(el => {
    el.classList.toggle('active', el.dataset.tab === tab);
  });
  renderCurrentTab();
}

function renderCurrentTab() {
  const content = document.getElementById('page-content');
  if (!content) return;
  content.scrollTop = 0;
  switch (AppState.currentTab) {
    case 'score': renderScorePage(content); break;
    case 'history': renderHistoryPage(content); break;
    case 'stats': renderStatsPage(content); break;
    case 'settings': renderSettingsPage(content); break;
  }
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

// ===== Login =====
function showLoginScreen() {
  const el = document.getElementById('login-screen');
  if (el) el.classList.remove('hidden');
  const versionEl = document.getElementById('login-version');
  if (versionEl) versionEl.textContent = `${t('auth_app_version')} ${APP_VERSION}`;
}

function hideLoginScreen() {
  const el = document.getElementById('login-screen');
  if (el) el.classList.add('hidden');
}

async function handleLogin() {
  const loginBtn = document.getElementById('login-btn');
  const emailInput = document.getElementById('login-email');
  if (loginBtn) loginBtn.disabled = true;

  const email = emailInput ? emailInput.value.trim() : '';
  if (!email || !email.includes('@')) {
    if (loginBtn) loginBtn.disabled = false;
    showToast('Please enter a valid email address', 'error');
    return;
  }

  try {
    // Check sheet access
    const result = await API.checkSheetAccess(email.trim());
    if (result.hasAccess) {
      API.setAuthEmail(email.trim());
      API.saveAuthData(email.trim(), result.role);
      hideLoginScreen();
      await initApp();
    } else {
      alert('你沒有此 Google Sheet 的編輯權限。請聯繫管理員。');
    }
  } catch (err) {
    alert('連接伺服器失敗: ' + (err.message || '未知錯誤'));
  } finally {
    if (loginBtn) loginBtn.disabled = false;
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
    html += `<div class="pending-panel">
      <span class="material-icons">cloud_upload</span>
      <span class="pending-text">${pending.length} ${t('score_pending_sync')}</span>
      <button class="pending-sync-btn" onclick="syncPending()">${t('settings_sync_now')}</button>
    </div>`;
  }

  html += `<div class="round-section">
    <h2 class="round-title">${t('score_latest_round')}</h2>
    <div id="round-summary-content"><div class="loading-spinner"><div class="spinner"></div></div></div>
    <div id="round-trend-chart" style="margin-top:16px;margin-left:-8px;margin-right:-8px"></div>
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
      API.fetchHistoryPage(0, 500),
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
        renderTrendChart(chartEl, roundGames, historyPage.players, t('round_trend_title'));
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
    <button class="submit-btn" onclick="handleSubmit()" ${AppState.score._submitting ? 'disabled' : ''}>
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
  if (!formArea) { renderCurrentTab(); return; }

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
    // Full re-render only once after submit completes, to refresh round summary
    renderCurrentTab();
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
    renderCurrentTab();
  } catch {
    showToast(t('toast_undo_failed'), 'error');
  }
}

async function syncPending() {
  try {
    const result = await API.syncPendingSubmissions();
    updatePendingBadge();
    AppState.refreshToken++;
    if (result.failed > 0) {
      showToast(`${t('settings_sync_result')}: ${result.failed} ${t('settings_sync_failed_suffix')}`, 'error');
    } else {
      showToast(t('toast_sync_success').replace('{count}', result.synced), 'success');
    }
    renderCurrentTab();
  } catch {
    showToast(t('settings_sync_error'), 'error');
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

  html += '<div id="history-list"></div>';
  html += '<div id="history-footer"></div>';

  container.innerHTML = html;
  loadHistory(true);
}

async function loadHistory(reset = false) {
  const h = AppState.history;
  if (h.loading) return;

  if (reset) { h.games = []; h.offset = 0; h.hasMore = true; }
  if (!h.hasMore && !reset) return;

  h.loading = true;
  const footerEl = document.getElementById('history-footer');
  if (footerEl) footerEl.innerHTML = `<div class="loading-spinner"><div class="spinner"></div></div>`;

  try {
    const result = await API.fetchHistoryPage(h.offset, 50);
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
  if (hideLastRound && result.length > 1) result.pop();
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

  // Group into rounds
  const rounds = groupIntoRounds(games, h.hasMore);

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
      const content = document.getElementById('page-content');
      if (content) {
        content.onscroll = () => {
          if (!h.loading && h.hasMore && content.scrollTop + content.clientHeight >= content.scrollHeight - 150) {
            loadHistory(false);
          }
        };
      }
    } else {
      footerEl.innerHTML = `<div class="history-footer">${t('history_loaded_all')} ${games.length} ${t('history_games_unit')}</div>`;
    }
  }
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
    const [statsData, historyPage] = await Promise.all([
      API.fetchStats(st.range),
      API.fetchHistoryPage(0, limit),
    ]);

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

  if (st.historyGames.length > 1) {
    html += `<div class="chart-title">${t('stats_trend_title')}</div>`;
    html += '<div id="stats-trend-chart" class="chart-container"></div>';
  }

  if (st.historyGames.length > 0) {
    html += `<div class="radar-section">
      <div class="chart-title">${t('stats_radar_title')}</div>
      <div id="stats-radar-chart" class="chart-container"></div>
    </div>`;
  }
  html += '</div>';

  contentEl.innerHTML = html;

  setTimeout(() => {
    if (st.historyGames.length > 1) {
      const trendEl = document.getElementById('stats-trend-chart');
      if (trendEl) renderTrendChart(trendEl, st.historyGames, playerNames, null, st.selectedPlayers);
    }
    if (st.historyGames.length > 0) {
      const radarEl = document.getElementById('stats-radar-chart');
      if (radarEl) renderRadarChart(radarEl, st.historyGames, playerNames, st.selectedPlayers);
    }
  }, 50);
}

function changeStatsRange(range) {
  AppState.stats.range = range;
  renderCurrentTab();
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

  // Server
  html += `<div class="settings-section">
    <div class="settings-section-title">${t('settings_server_status')}</div>
    <div class="settings-card">
      <div class="settings-row">
        <span class="settings-row-label">${t('settings_server_status')}</span>
        <div class="server-status">
          <span id="server-status-text" class="settings-row-value">${getServerStatusText()}</span>
          <span id="server-status-dot" class="status-dot ${getServerStatusClass()}"></span>
          <button class="settings-action-btn" onclick="testServerConnection()" style="margin-left:8px">${t('settings_server_test_button')}</button>
        </div>
      </div>
    </div>
  </div>`;

  // Offline sync
  html += `<div class="settings-section">
    <div class="settings-section-title">${t('settings_offline_sync')}</div>
    <div class="settings-card">
      <div class="settings-row">
        <span class="settings-row-label">${t('settings_pending_records')}</span>
        <span class="settings-row-value">${pending.length > 0 ? pending.length : t('settings_no_pending')}</span>
      </div>`;
  if (pending.length > 0) {
    html += `<div class="settings-row"><button class="settings-action-btn" onclick="syncPending()" style="width:100%">${t('settings_sync_now')}</button></div>
      <div class="settings-row"><button class="settings-action-btn danger" onclick="forceClearPending()" style="width:100%">${t('sync_panel_force_clear')}</button></div>`;
  }
  html += `</div></div>`;

  // About
  html += `<div class="settings-section">
    <div class="settings-section-title">${t('settings_about')}</div>
    <div class="settings-card">
      ${authEmail ? `<div class="settings-row"><span class="settings-row-label">${t('auth_logged_in_as')}</span><span class="settings-row-value">${authEmail}</span></div>` : ''}
      <div class="settings-row">
        <span class="settings-row-label">${t('settings_app_version')}</span>
        <span class="settings-row-value">${APP_VERSION} (Web)</span>
      </div>
      <div class="settings-row">
        <span class="settings-row-label">${t('settings_script_version')}</span>
        <span class="settings-row-value" id="script-version-text">${AppState.scriptVersion || t('common_loading')}</span>
      </div>
      <div class="settings-row">
        <span class="settings-row-label" style="flex:1">${t('settings_about_desc_prefix')}Google Sheets${t('settings_about_desc_suffix')}</span>
      </div>
    </div>
  </div>`;

  // Auth
  html += `<div class="settings-section">
    <div class="settings-card">
      <div class="settings-row" style="cursor:pointer" onclick="handleLogout()">
        <span class="settings-row-label text-error">${t('auth_relogin_settings')}</span>
        <span class="material-icons text-muted" style="font-size:20px">chevron_right</span>
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

async function testServerConnection() {
  AppState.connectionStatus = 'testing';
  const statusText = document.getElementById('server-status-text');
  const statusDot = document.getElementById('server-status-dot');
  if (statusText) statusText.textContent = t('settings_server_testing');
  if (statusDot) statusDot.className = 'status-dot testing';

  const result = await API.testConnectionWithLatency();
  AppState.connectionStatus = result.ok ? (result.latencyMs > 3000 ? 'slow' : 'normal') : 'failed';
  AppState.isOnline = result.ok;

  if (statusText) statusText.textContent = getServerStatusText();
  if (statusDot) statusDot.className = `status-dot ${getServerStatusClass()}`;
}

function forceClearPending() {
  if (confirm(t('sync_panel_force_clear_confirm'))) {
    API.clearPendingSubmissions();
    updatePendingBadge();
    showToast(t('sync_panel_cleared'), 'success');
    renderCurrentTab();
  }
}

function handleLogout() {
  API.clearAuth();
  showLoginScreen();
}

// ===== CHARTS =====
function renderTrendChart(container, games, allPlayers, title, selectedPlayers) {
  if (!games || games.length < 2) return;

  const players = selectedPlayers || allPlayers;
  const width = Math.max(container.clientWidth || 360, container.parentElement ? container.parentElement.clientWidth - 8 : 360);
  const height = 220;
  const padding = { top: 20, right: 16, bottom: 36, left: 50 };
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

  const colors = ['#0a7ea4', '#EF4444', '#22C55E', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16', '#F97316', '#6366F1'];

  let svg = `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`;

  const gridLines = 5;
  for (let i = 0; i <= gridLines; i++) {
    const y = padding.top + (chartH / gridLines) * i;
    const val = Math.round(maxVal - (maxVal - minVal) * (i / gridLines));
    svg += `<line x1="${padding.left}" y1="${y}" x2="${width - padding.right}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>`;
    svg += `<text x="${padding.left - 6}" y="${y + 4}" text-anchor="end" fill="var(--muted)" font-size="10">${val}</text>`;
  }

  if (minVal < 0 && maxVal > 0) {
    const zeroY = padding.top + chartH * (maxVal / (maxVal - minVal));
    svg += `<line x1="${padding.left}" y1="${zeroY}" x2="${width - padding.right}" y2="${zeroY}" stroke="var(--muted)" stroke-width="1" stroke-dasharray="4,4"/>`;
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
    svg += `<path d="${path}" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>`;
  });

  // X-axis numbers
  const totalGames = reversedGames.length;
  const xTickCount = Math.min(totalGames, 8);
  for (let i = 0; i < xTickCount; i++) {
    const gameIdx = Math.round(i * (totalGames - 1) / Math.max(xTickCount - 1, 1));
    const x = padding.left + (chartW / Math.max(totalGames - 1, 1)) * gameIdx;
    svg += `<text x="${x.toFixed(1)}" y="${padding.top + chartH + 16}" text-anchor="middle" fill="var(--muted)" font-size="10">${gameIdx + 1}</text>`;
  }
  svg += `<text x="${width / 2}" y="${height - 2}" text-anchor="middle" fill="var(--muted)" font-size="10">${t('trend_x_label')}</text>`;
  svg += '</svg>';

  let legend = '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:4px 0;justify-content:center">';
  players.forEach((player, pIdx) => {
    const color = colors[pIdx % colors.length];
    legend += `<span style="display:flex;align-items:center;gap:3px;font-size:11px;color:var(--muted)">
      <span style="width:10px;height:3px;background:${color};border-radius:2px"></span>${player}
    </span>`;
  });
  legend += '</div>';

  // Title above chart, legend below chart (centered)
  const chartTitle = title ? `<div style="font-size:calc(14px * var(--font-scale));font-weight:600;color:var(--foreground);margin-bottom:8px">${title}</div>` : '';
  container.innerHTML = chartTitle + svg + legend;
}

function renderRadarChart(container, games, allPlayers, selectedPlayers) {
  if (!games || games.length === 0) return;

  const players = selectedPlayers || allPlayers;
  const size = Math.min(container.clientWidth || 360, 400);
  const cx = size / 2, cy = size / 2;
  const radius = size * 0.35;

  const allStats = {};
  allPlayers.forEach(p => {
    let gamesPlayed = 0, landlordGames = 0, wins = 0, landlordWins = 0, farmerWins = 0, bigWins = 0, bigLosses = 0;
    games.forEach(g => {
      let score = 0, isLandlord = false;
      // Use scores map if available
      if (g.scores && g.scores[p] !== undefined) {
        score = g.scores[p];
        isLandlord = (p === g.landlord);
      } else if (p === g.landlord) {
        score = g.landlordScore; isLandlord = true;
      } else if (p === g.farmer1 || p === g.farmer2) {
        score = -g.landlordScore / 2;
      } else return;
      if (g.scores && g.scores[p] === undefined) return;
      gamesPlayed++;
      if (isLandlord) landlordGames++;
      if (score > 0) { wins++; if (isLandlord) landlordWins++; else farmerWins++; }
      if (Math.abs(score) >= 50) { if (score > 0) bigWins++; else bigLosses++; }
    });
    const farmerGames = gamesPlayed - landlordGames;
    allStats[p] = {
      engagement: gamesPlayed,
      landlordRate: gamesPlayed > 0 ? landlordGames / gamesPlayed : 0,
      winRate: gamesPlayed > 0 ? wins / gamesPlayed : 0,
      volatility: gamesPlayed > 0 ? (bigWins + bigLosses) / gamesPlayed : 0,
      attack: landlordGames > 0 ? landlordWins / landlordGames : 0,
      defense: farmerGames > 0 ? farmerWins / farmerGames : 0,
    };
  });

  const dims = ['engagement', 'landlordRate', 'winRate', 'volatility', 'attack', 'defense'];
  const maxVals = {};
  dims.forEach(d => { maxVals[d] = Math.max(...allPlayers.map(p => allStats[p][d]), 0.01); });

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
    svg += `<polygon points="${points}" fill="none" stroke="var(--border)" stroke-width="0.5"/>`;
  }

  for (let i = 0; i < 6; i++) {
    const angle = startAngle + angleStep * i;
    const x = cx + radius * Math.cos(angle);
    const y = cy + radius * Math.sin(angle);
    svg += `<line x1="${cx}" y1="${cy}" x2="${x}" y2="${y}" stroke="var(--border)" stroke-width="0.5"/>`;
    const lx = cx + (radius + 18) * Math.cos(angle);
    const ly = cy + (radius + 18) * Math.sin(angle);
    const anchor = Math.abs(Math.cos(angle)) < 0.1 ? 'middle' : Math.cos(angle) > 0 ? 'start' : 'end';
    svg += `<text x="${lx.toFixed(1)}" y="${(ly + 4).toFixed(1)}" text-anchor="${anchor}" fill="var(--muted)" font-size="10">${dimLabels[i]}</text>`;
  }

  const colors = ['#0a7ea4', '#EF4444', '#22C55E', '#F59E0B', '#8B5CF6', '#EC4899', '#06B6D4', '#84CC16'];
  players.forEach((player, pIdx) => {
    const stats = allStats[player];
    if (!stats) return;
    const color = colors[pIdx % colors.length];
    let points = '';
    dims.forEach((d, i) => {
      const val = stats[d] / maxVals[d];
      const r = radius * Math.max(val, 0.05);
      const angle = startAngle + angleStep * i;
      points += `${(cx + r * Math.cos(angle)).toFixed(1)},${(cy + r * Math.sin(angle)).toFixed(1)} `;
    });
    svg += `<polygon points="${points}" fill="${color}20" stroke="${color}" stroke-width="2"/>`;
    dims.forEach((d, i) => {
      const val = stats[d] / maxVals[d];
      const r = radius * Math.max(val, 0.05);
      const angle = startAngle + angleStep * i;
      svg += `<circle cx="${(cx + r * Math.cos(angle)).toFixed(1)}" cy="${(cy + r * Math.sin(angle)).toFixed(1)}" r="3" fill="${color}"/>`;
    });
  });

  svg += '</svg>';

  let legend = '<div style="display:flex;flex-wrap:wrap;gap:8px;padding:4px 0;margin-bottom:4px">';
  players.forEach((player, pIdx) => {
    const color = colors[pIdx % colors.length];
    legend += `<span style="display:flex;align-items:center;gap:3px;font-size:11px;color:var(--muted)">
      <span style="width:8px;height:8px;background:${color};border-radius:50%"></span>${player}
    </span>`;
  });
  legend += '</div>';

  container.innerHTML = legend + svg;
}
