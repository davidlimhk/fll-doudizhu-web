// ===== API Layer =====
// Exact clone of the mobile app's lib/api.ts + lib/hmac.ts

const STORAGE_KEYS = {
  WEB_APP_URL: 'fll_web_app_url',
  PENDING_QUEUE: 'fll_pending_queue',
  HISTORY_CACHE: 'fll_history_cache',
  PARAMS_CACHE: 'fll_params_cache',
  STATS_CACHE: 'fll_stats_cache',
  LAST_COMBO: 'fll_last_player_combo',
  SETTINGS: 'fll_settings',
  AUTH_STATUS: '@fll_auth_status',
  AUTH_EMAIL: '@fll_auth_email',
  AUTH_VERIFIED_AT: '@fll_auth_verified_at',
  AUTH_ROLE: '@fll_auth_role',
};

const DEFAULT_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbysRk-4xU1tvBmzm9qyowxbZMUtpQvx_2XftlZbuW9lrwhNz_m2KGQBdP7-yiP3J81C9A/exec';
const API_SECRET = 'FLL_DDZ_2025_S3cR3t_K3y_X9mP2vQ7';
const APP_VERSION_STR = '2.0.58';
const PERMISSION_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours

// Auth email (global)
let _authEmail = null;

const API = {
  // ===== Auth Email =====
  setAuthEmail(email) { _authEmail = email; },
  getAuthEmail() { return _authEmail; },

  // ===== URL Management =====
  getWebAppUrl() {
    return localStorage.getItem(STORAGE_KEYS.WEB_APP_URL) || DEFAULT_WEB_APP_URL;
  },
  setWebAppUrl(url) {
    localStorage.setItem(STORAGE_KEYS.WEB_APP_URL, url);
  },

  // ===== HMAC Signing (matches lib/hmac.ts exactly) =====
  signRequest(action, userEmail) {
    const ts = Math.floor(Date.now() / 1000).toString();
    const nonce = this._generateNonce();
    const message = `${ts}${nonce}${action}${userEmail}`;
    const sig = this._hmacSha256(API_SECRET, message);
    return { sig, ts, nonce };
  },

  _generateNonce() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';
    for (let i = 0; i < 16; i++) {
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
  },

  _hmacSha256(key, message) {
    // Use CryptoJS (loaded from CDN in index.html)
    if (typeof CryptoJS !== 'undefined') {
      return CryptoJS.HmacSHA256(message, key).toString(CryptoJS.enc.Hex);
    }
    // Fallback: empty (will fail server-side verification)
    console.error('CryptoJS not loaded, HMAC signing unavailable');
    return '';
  },

  // ===== Core GET Fetch (direct GAS call - CORS supported) =====
  async fetchFromWebApp(action, params = {}) {
    const gasUrl = this.getWebAppUrl();
    if (!gasUrl) throw new Error('Web App URL 未设置');

    const AUTH_EXEMPT_ACTIONS = ['checkAccess', 'getSheetUrl', 'requestAccess'];
    if (!AUTH_EXEMPT_ACTIONS.includes(action) && !_authEmail) {
      throw new Error('未登入，無法調用 API');
    }

    const authParams = {};
    if (_authEmail) authParams.userEmail = _authEmail;

    const hmacParams = this.signRequest(action, _authEmail || '');

    const queryParams = new URLSearchParams({
      action,
      appVersion: APP_VERSION_STR,
      ...authParams,
      ...hmacParams,
      ...params,
    });

    const targetUrl = `${gasUrl}?${queryParams.toString()}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    try {
      const response = await fetch(targetUrl, { method: 'GET', redirect: 'follow', signal: controller.signal });
      clearTimeout(timeoutId);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (!data.success) {
        const errorCode = data.code || data.error;
        if (errorCode === 'AUTH_REQUIRED' || errorCode === 'ACCESS_DENIED') {
          this._handleSessionExpired();
        }
        throw new Error(data.message || data.error || '请求失败');
      }
      return data;
    } catch (error) {
      clearTimeout(timeoutId);
      if (error.name === 'AbortError') throw new Error('请求超时');
      throw error;
    }
  },

  // ===== Core POST Fetch (direct GAS call - CORS supported) =====
  async postToWebApp(payload) {
    const gasUrl = this.getWebAppUrl();
    if (!gasUrl) throw new Error('Web App URL 未设置');
    if (!_authEmail) throw new Error('未登入，無法調用 API');

    const hmacParams = this.signRequest(payload.action || 'submit', _authEmail || '');

    const bodyPayload = JSON.stringify({
      ...payload,
      appVersion: APP_VERSION_STR,
      userEmail: _authEmail,
      ...hmacParams,
    });

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);

    let response;
    try {
      response = await fetch(gasUrl, {
        method: 'POST',
        redirect: 'follow',
        headers: { 'Content-Type': 'text/plain' },
        body: bodyPayload,
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
    } catch (fetchError) {
      clearTimeout(timeoutId);
      if (fetchError.name === 'AbortError') throw new Error('请求超时');
      throw fetchError;
    }

    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const responseText = await response.text();

    // Handle empty response (GAS sometimes returns empty body after redirect)
    if (!responseText || responseText.trim() === '') {
      return { success: true };
    }

    // Handle HTML response (GAS redirect landing page)
    if (responseText.trim().startsWith('<') || responseText.trim().startsWith('<!DOCTYPE')) {
      return { success: true };
    }

    let data;
    try {
      data = JSON.parse(responseText);
    } catch {
      return { success: true };
    }

    const isSuccess = data.success === true || data.success === 'true' || data.success === 1;
    if (!isSuccess) {
      const errorCode = data.code || data.error || '';
      if (errorCode === 'AUTH_REQUIRED' || errorCode === 'ACCESS_DENIED') {
        this._handleSessionExpired();
        throw new Error(String(errorCode));
      }
      // GAS sometimes returns a B2 validation error from Google Sheets
      // even though the data was successfully written. Treat this as success.
      const errorMsg = data.message || data.error || '';
      if (errorMsg.includes('data validation rules') || errorMsg.includes('cell B')) {
        console.warn('[API] Ignoring sheet validation warning (data was written):', errorMsg);
        return { success: true, _validationWarning: true };
      }
      throw new Error(errorMsg || '提交失败');
    }
    return data;
  },

  _handleSessionExpired() {
    console.warn('[API] Session expired');
    _authEmail = null;
    localStorage.removeItem(STORAGE_KEYS.AUTH_STATUS);
    localStorage.removeItem(STORAGE_KEYS.AUTH_EMAIL);
    localStorage.removeItem(STORAGE_KEYS.AUTH_VERIFIED_AT);
    localStorage.removeItem(STORAGE_KEYS.AUTH_ROLE);
    // Show login screen
    if (typeof showLoginScreen === 'function') showLoginScreen();
  },

  // ===== Parameters =====
  async fetchParams() {
    try {
      const data = await this.fetchFromWebApp('getParams');
      const params = {
        players: data.players || [],
        scoreOptions: data.scoreOptions || [],
        version: data.version || '',
      };
      localStorage.setItem(STORAGE_KEYS.PARAMS_CACHE, JSON.stringify(params));
      return params;
    } catch {
      const cached = localStorage.getItem(STORAGE_KEYS.PARAMS_CACHE);
      if (cached) return JSON.parse(cached);
      return { players: [], scoreOptions: [], version: '' };
    }
  },

  // ===== Submit Game (POST) =====
  async submitGame(landlord, farmer1, farmer2, landlordScore) {
    const clientTimestamp = new Date().toISOString();
    const payload = {
      action: 'submit',
      landlord,
      farmer1,
      farmer2,
      landlordScore,
      clientTimestamp,
    };
    const result = await this.postToWebApp(payload);
    // GAS stores timestamps in 'YYYY-MM-DD HH:MM:SS' format (Asia/Shanghai UTC+8)
    // When the response has a validation warning, we don't get the server timestamp back.
    // Fetch the latest record to get the actual stored timestamp for undo.
    let serverTimestamp = result.timestamp;
    if (!serverTimestamp || result._validationWarning) {
      try {
        const history = await this.fetchHistoryPage(0, 1);
        if (history.data && history.data.length > 0) {
          serverTimestamp = history.data[0].timestamp;
        }
      } catch (e) {
        console.warn('[API] Could not fetch server timestamp for undo:', e);
      }
    }
    return { timestamp: serverTimestamp || clientTimestamp };
  },

  // ===== Delete Last Game (POST) =====
  async deleteLastGame(timestamp) {
    const payload = {
      action: 'deleteLastGame',
      timestamp,
      clientTimestamp: timestamp,
    };
    try {
      await this.postToWebApp(payload);
    } catch (error) {
      const msg = error?.message || String(error);
      if (this._isRetryableError(msg)) {
        throw error;
      }
      // Non-network errors: GAS likely processed the deletion
    }
  },

  _isRetryableError(errMsg) {
    if (errMsg.includes('AUTH_REQUIRED') || errMsg.includes('ACCESS_DENIED') ||
        errMsg.includes('未登入') || errMsg.includes('NOT_LOGGED_IN')) return true;
    if (errMsg.includes('Network') || errMsg.includes('fetch') ||
        errMsg.includes('Failed to fetch') || errMsg.includes('请求超时') ||
        errMsg.includes('AbortError') || errMsg.includes('timeout')) return true;
    if (/^HTTP\s*5\d{2}/.test(errMsg)) return true;
    if (errMsg.includes('Web App URL')) return true;
    return false;
  },

  // ===== Fetch Stats =====
  async fetchStats(range) {
    const apiRange = range === '最近参与的1000局' ? 'SMA-1000' : range;
    try {
      const data = await this.fetchFromWebApp('getStats', { range: apiRange });
      const stats = data.stats || [];
      localStorage.setItem(`${STORAGE_KEYS.STATS_CACHE}_${range}`, JSON.stringify(stats));
      return stats;
    } catch {
      const cached = localStorage.getItem(`${STORAGE_KEYS.STATS_CACHE}_${range}`);
      if (cached) return JSON.parse(cached);
      return [];
    }
  },

  // ===== Fetch History =====
  async fetchHistoryPage(offset, limit) {
    try {
      const data = await this.fetchFromWebApp('getHistory', {
        offset: String(offset),
        limit: String(limit),
      });

      // Transform raw data: {timestamp, scores:{player:score}} -> enriched format
      const rawData = data.data || [];
      const total = data.total || 0;
      const enrichedData = rawData.map((game, idx) => {
        return this._enrichGameRecord(game, total - offset - idx);
      });

      const result = {
        players: data.players || [],
        data: enrichedData,
        total: total,
        hasMore: data.hasMore === true,
      };

      // Cache first page for offline
      if (offset === 0) {
        localStorage.setItem(STORAGE_KEYS.HISTORY_CACHE, JSON.stringify({
          players: result.players,
          data: result.data.slice(0, 200),
          total: result.total,
        }));
      }

      return result;
    } catch (error) {
      // Offline fallback
      if (offset === 0) {
        const cached = this.getCachedHistory();
        if (cached) {
          return { ...cached, hasMore: false };
        }
      }
      throw error;
    }
  },

  // Transform a raw game record {timestamp, scores} into enriched format
  _enrichGameRecord(game, gameNumber) {
    const scores = game.scores || {};
    const players = Object.keys(scores);
    if (players.length !== 3) {
      // Fallback: return as-is with defaults
      return {
        ...game,
        gameNumber: gameNumber || 0,
        landlord: players[0] || '?',
        farmer1: players[1] || '?',
        farmer2: players[2] || '?',
        landlordScore: 0,
        isCurrentRound: false,
      };
    }

    // In doudizhu: landlord score = -(farmer1 score + farmer2 score)
    // The landlord has a score whose sign differs from the other two,
    // or whose absolute value is 2x the others.
    // Find the landlord: the player whose score sign is unique
    let landlordIdx = -1;
    const scoreVals = players.map(p => scores[p]);
    
    // Check which player has the unique sign
    const signs = scoreVals.map(v => v > 0 ? 1 : v < 0 ? -1 : 0);
    for (let i = 0; i < 3; i++) {
      const otherSigns = signs.filter((_, j) => j !== i);
      if (signs[i] !== 0 && otherSigns[0] === otherSigns[1] && signs[i] !== otherSigns[0]) {
        landlordIdx = i;
        break;
      }
    }

    // Fallback: landlord is the one with the largest absolute score
    if (landlordIdx === -1) {
      let maxAbs = -1;
      scoreVals.forEach((v, i) => {
        if (Math.abs(v) > maxAbs) { maxAbs = Math.abs(v); landlordIdx = i; }
      });
    }

    const landlord = players[landlordIdx];
    const farmers = players.filter((_, i) => i !== landlordIdx);
    const landlordScore = scores[landlord];

    return {
      timestamp: game.timestamp,
      scores: game.scores,
      gameNumber: gameNumber || 0,
      landlord,
      farmer1: farmers[0],
      farmer2: farmers[1],
      landlordScore,
      isCurrentRound: false,
    };
  },

  getCachedHistory() {
    try {
      const cached = localStorage.getItem(STORAGE_KEYS.HISTORY_CACHE);
      if (cached) return JSON.parse(cached);
    } catch {}
    return null;
  },

  // ===== Check Access =====
  async checkSheetAccess(email) {
    const data = await this.fetchFromWebApp('checkAccess', { email });
    return { hasAccess: data.hasAccess === true, role: data.role };
  },

  // ===== Script Version =====
  async getScriptVersion() {
    try {
      const data = await this.fetchFromWebApp('getVersion');
      return data.version || '未知';
    } catch { return '未知'; }
  },

  // ===== Pending Queue (Offline) =====
  getPendingSubmissions() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.PENDING_QUEUE);
      return raw ? JSON.parse(raw) : [];
    } catch { return []; }
  },

  addPendingSubmission(data) {
    const pending = this.getPendingSubmissions();
    pending.push({
      id: Date.now().toString() + Math.random().toString(36).slice(2, 6),
      ...data,
      timestamp: new Date().toISOString(),
    });
    localStorage.setItem(STORAGE_KEYS.PENDING_QUEUE, JSON.stringify(pending));
  },

  removePendingSubmission(id) {
    const pending = this.getPendingSubmissions().filter(p => p.id !== id);
    localStorage.setItem(STORAGE_KEYS.PENDING_QUEUE, JSON.stringify(pending));
  },

  clearPendingSubmissions() {
    localStorage.removeItem(STORAGE_KEYS.PENDING_QUEUE);
  },

  async syncPendingSubmissions() {
    if (!_authEmail) return { synced: 0, failed: 0, lastError: 'NOT_LOGGED_IN' };

    const pending = this.getPendingSubmissions();
    if (pending.length === 0) return { synced: 0, failed: 0 };

    const idsToRemove = [];
    const idsToKeep = [];
    let synced = 0, failed = 0, lastError = '', authFailed = false;

    for (const item of pending) {
      if (authFailed) { idsToKeep.push(item.id); failed++; continue; }

      try {
        await this.submitGame(item.landlord, item.farmer1, item.farmer2, item.landlordScore);
        idsToRemove.push(item.id);
        synced++;
      } catch (err) {
        const msg = err?.message || String(err);
        if (this._isRetryableError(msg)) {
          idsToKeep.push(item.id);
          failed++;
          lastError = msg;
          if (msg.includes('AUTH_REQUIRED') || msg.includes('ACCESS_DENIED') || msg.includes('未登入')) {
            authFailed = true;
          }
        } else {
          // Non-retryable: GAS likely processed it
          idsToRemove.push(item.id);
          synced++;
        }
      }
    }

    // Remove synced items
    if (idsToRemove.length > 0) {
      const remaining = this.getPendingSubmissions().filter(p => !idsToRemove.includes(p.id));
      localStorage.setItem(STORAGE_KEYS.PENDING_QUEUE, JSON.stringify(remaining));
    }

    return { synced, failed, lastError };
  },

  // ===== Connection Test =====
  async testConnectionWithLatency() {
    const start = Date.now();
    try {
      await this.fetchFromWebApp('getParams');
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  },

  // ===== Settings =====
  getSettings() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.SETTINGS);
      return raw ? JSON.parse(raw) : {};
    } catch { return {}; }
  },
  saveSettings(settings) {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
  },

  // ===== Last Combo =====
  getLastCombo() {
    try {
      const raw = localStorage.getItem(STORAGE_KEYS.LAST_COMBO);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  },
  saveLastCombo(combo) {
    localStorage.setItem(STORAGE_KEYS.LAST_COMBO, JSON.stringify(combo));
  },

  // ===== Auth Persistence =====
  getAuthData() {
    try {
      return {
        status: localStorage.getItem(STORAGE_KEYS.AUTH_STATUS),
        email: localStorage.getItem(STORAGE_KEYS.AUTH_EMAIL),
        verifiedAt: localStorage.getItem(STORAGE_KEYS.AUTH_VERIFIED_AT),
        role: localStorage.getItem(STORAGE_KEYS.AUTH_ROLE),
      };
    } catch { return {}; }
  },

  saveAuthData(email, role) {
    const now = Date.now();
    localStorage.setItem(STORAGE_KEYS.AUTH_STATUS, 'authorized');
    localStorage.setItem(STORAGE_KEYS.AUTH_EMAIL, email);
    localStorage.setItem(STORAGE_KEYS.AUTH_VERIFIED_AT, now.toString());
    localStorage.setItem(STORAGE_KEYS.AUTH_ROLE, role || 'editor');
  },

  clearAuth() {
    _authEmail = null;
    localStorage.removeItem(STORAGE_KEYS.AUTH_STATUS);
    localStorage.removeItem(STORAGE_KEYS.AUTH_EMAIL);
    localStorage.removeItem(STORAGE_KEYS.AUTH_VERIFIED_AT);
    localStorage.removeItem(STORAGE_KEYS.AUTH_ROLE);
  },

  isAuthCacheValid() {
    const data = this.getAuthData();
    if (data.status !== 'authorized' || !data.email || !data.verifiedAt) return false;
    const elapsed = Date.now() - parseInt(data.verifiedAt, 10);
    return elapsed < PERMISSION_CACHE_TTL;
  },

  getCachedAuthEmail() {
    if (this.isAuthCacheValid()) {
      return localStorage.getItem(STORAGE_KEYS.AUTH_EMAIL);
    }
    return null;
  },
};

// ===== Pending Merge Utilities =====
function mergeWithPending(serverGames, pendingItems) {
  if (!pendingItems || pendingItems.length === 0) return serverGames;
  const pendingGames = pendingItems.map((p, i) => {
    const farmerScore = -p.landlordScore / 2;
    return {
      gameNumber: (serverGames.length > 0 ? serverGames[0].gameNumber + i + 1 : i + 1),
      timestamp: p.timestamp,
      landlord: p.landlord,
      farmer1: p.farmer1,
      farmer2: p.farmer2,
      landlordScore: p.landlordScore,
      scores: { [p.landlord]: p.landlordScore, [p.farmer1]: farmerScore, [p.farmer2]: farmerScore },
      isCurrentRound: true,
      isPending: true,
      pendingId: p.id,
    };
  });
  return [...pendingGames.reverse(), ...serverGames];
}

function overlayPendingOnStats(serverStats, pendingItems) {
  if (!pendingItems || pendingItems.length === 0) return serverStats;
  const statsMap = {};
  serverStats.forEach(s => { statsMap[s.name] = { ...s }; });

  pendingItems.forEach(p => {
    const farmerScore = -p.landlordScore / 2;
    [p.landlord, p.farmer1, p.farmer2].forEach(name => {
      if (!statsMap[name]) {
        statsMap[name] = { name, totalScore: 0, avgScore: 0, gamesPlayed: 0, winRate: 0, hasPendingData: true };
      }
      const s = statsMap[name];
      const score = name === p.landlord ? p.landlordScore : farmerScore;
      s.totalScore += score;
      s.gamesPlayed += 1;
      s.hasPendingData = true;
      s.avgScore = s.gamesPlayed > 0 ? s.totalScore / s.gamesPlayed : 0;
      if (score > 0) {
        const prevWins = Math.round(s.winRate / 100 * (s.gamesPlayed - 1));
        s.winRate = s.gamesPlayed > 0 ? ((prevWins + 1) / s.gamesPlayed) * 100 : 0;
      }
    });
  });

  return Object.values(statsMap).sort((a, b) => b.totalScore - a.totalScore);
}

function filterCurrentRoundGames(games) {
  if (games.length === 0) return [];
  const TWO_HOURS = 2 * 60 * 60 * 1000;
  const result = [games[0]];
  for (let i = 1; i < games.length; i++) {
    const prevTime = new Date(games[i - 1].timestamp).getTime();
    const currTime = new Date(games[i].timestamp).getTime();
    if (prevTime - currTime > TWO_HOURS) break;
    result.push(games[i]);
  }
  return result;
}
