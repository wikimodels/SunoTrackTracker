// background.js — service worker
'use strict';

let cachedHeaders = {
  authorization: null,
  deviceId: null,
  updatedAt: 0
};

// ── 1. Перехват заголовков ────────────────────────────────────────────────
try {
  chrome.webRequest.onBeforeSendHeaders.addListener(
    (details) => {
      for (const h of details.requestHeaders || []) {
        const name = h.name.toLowerCase();
        if (name === 'authorization' && h.value && h.value.startsWith('Bearer ')) {
          cachedHeaders.authorization = h.value;
          cachedHeaders.updatedAt = Date.now();
        }
        if (name === 'device-id' && h.value) {
          cachedHeaders.deviceId = h.value;
          cachedHeaders.updatedAt = Date.now();
        }
      }
      // сохраняем в session storage для персиста между рестартами SW
      if (cachedHeaders.authorization) {
        console.log('[SunoProv][DEBUG] captured headers: auth?', !!cachedHeaders.authorization, 'deviceId?', !!cachedHeaders.deviceId);
        chrome.storage.session.set({ sunoHeaders: cachedHeaders }).catch(() => {});
      }
    },
    { urls: ['https://studio-api-prod.suno.com/api/*'] },
    ['requestHeaders']
  );
} catch (e) {
  console.warn('[SunoProv] webRequest listener failed:', e);
}

// Восстановить из storage при старте SW
chrome.storage.session.get('sunoHeaders').then(obj => {
  if (obj.sunoHeaders) cachedHeaders = obj.sunoHeaders;
}).catch(() => {});

// ── 2. Helpers ─────────────────────────────────────────────────────────────
async function getHeaders() {
  // Пробуем из кэша
  if (cachedHeaders.authorization && Date.now() - cachedHeaders.updatedAt < 5 * 60 * 1000) {
    return cachedHeaders;
  }
  // Пробуем из storage
  try {
    const obj = await chrome.storage.session.get('sunoHeaders');
    if (obj.sunoHeaders && obj.sunoHeaders.authorization) {
      cachedHeaders = obj.sunoHeaders;
      return cachedHeaders;
    }
  } catch (_) {}
  // Пробуем через Clerk (контент-скрипт)
  try {
    const tabs = await chrome.tabs.query({ url: 'https://suno.com/*' });
    for (const tab of tabs) {
      if (!tab.id) continue;
      try {
        const resp = await chrome.tabs.sendMessage(tab.id, { type: 'GET_TOKEN_VIA_CLERK' });
        if (resp && resp.token) {
          cachedHeaders.authorization = 'Bearer ' + resp.token.replace(/^Bearer\s+/, '');
          cachedHeaders.updatedAt = Date.now();
          await chrome.storage.session.set({ sunoHeaders: cachedHeaders });
          return cachedHeaders;
        }
      } catch (_) {}
    }
  } catch (_) {}
  return cachedHeaders;
}

function buildHeaders(stored) {
  const h = {
    'accept': '*/*',
    'content-type': 'application/json',
    'origin': 'https://suno.com',
    'referer': 'https://suno.com/'
  };
  if (stored.authorization) h['authorization'] = stored.authorization;
  if (stored.deviceId) h['device-id'] = stored.deviceId;
  // browser-token и device-id иногда не требуются для GET, но добавим если есть
  return h;
}

async function fetchJson(url, opts, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const res = await fetch(url, opts);
    if (res.status === 429) {
      const retryAfter = parseInt(res.headers.get('retry-after') || '5', 10);
      const wait = (isNaN(retryAfter) ? 5 : retryAfter) * 1000 + Math.random() * 1000;
      console.warn(`[SunoProv] 429 rate limited @ ${url} — waiting ${Math.round(wait)}ms (attempt ${attempt + 1}/${retries})`);
      await sleep(wait);
      continue;
    }
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      throw new Error(`HTTP ${res.status} ${res.statusText} @ ${url} — ${txt.slice(0, 300)}`);
    }
    return res.json();
  }
  throw new Error(`HTTP 429 rate limited @ ${url} — retries exhausted`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function extractRow(clip, workspaceName) {
  // clip_roots может быть пустым — тогда сам клип и есть корень
  const roots = clip.clip_roots && clip.clip_roots.clips;
  const hasRoot = roots && roots.length > 0;
  return {
    clip_id: clip.id || '',
    title: clip.title || '',
    root_id: hasRoot ? roots[0].id : (clip.id || ''),
    root_title: hasRoot ? roots[0].title : (clip.title || ''),
    task: (clip.metadata && clip.metadata.task) || '',
    edited_clip_id: (clip.metadata && clip.metadata.edited_clip_id) || '',
    cover_clip_id: (clip.metadata && clip.metadata.cover_clip_id) || '',
    artist: clip.display_name || '',
    handle: clip.handle || '',
    workspace: workspaceName || (clip.project && clip.project.name) || '',
    created_at: clip.created_at || '',
    is_public: clip.is_public ? 'true' : 'false'
  };
}

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = v => {
    const s = String(v ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  };
  const lines = [cols.join(',')];
  for (const r of rows) {
    lines.push(cols.map(c => esc(r[c])).join(','));
  }
  return lines.join('\n');
}

// ── 3. API: проекты и клипы ───────────────────────────────────────────────
async function listAllProjects(headers) {
  const h = buildHeaders(headers);
  let page = 1;
  const all = [];
  while (true) {
    const url = `https://studio-api-prod.suno.com/api/project/me?page=${page}&sort=max_created_at_last_updated_clip&show_trashed=false&exclude_shared=false`;
    const data = await fetchJson(url, { headers: h });
    console.log('[SunoProv][DEBUG] project/me page', page, 'raw keys:', Object.keys(data), 'raw:', JSON.stringify(data).slice(0, 2000));
    // Структура ответа не задокументирована точно — пробуем несколько вариантов
    let items = null;
    if (Array.isArray(data)) items = data;
    else if (Array.isArray(data.projects)) items = data.projects;
    else if (Array.isArray(data.results)) items = data.results;
    else if (Array.isArray(data.items)) items = data.items;
    else if (Array.isArray(data.data)) items = data.data;
    else {
      for (const v of Object.values(data)) {
        if (Array.isArray(v)) { items = v; break; }
      }
    }
    if (!items || items.length === 0) {
      console.log(`[SunoProv] project/me page ${page}: empty — done, total ${all.length}`);
      break;
    }
    all.push(...items);
    console.log(`[SunoProv] project/me page ${page}: +${items.length} (total ${all.length})`);
    // Пагинация до пустой страницы — не полагаемся на has_more (может отсутствовать при 100+ воркспейсов)
    page++;
    await sleep(800);
  }
  console.log(`[SunoProv] project/me total: ${all.length} workspaces`);
  return all;
}

async function fetchWorkspaceClips(headers, workspaceId, workspaceName, onProgress) {
  const h = buildHeaders(headers);
  let cursor = null;
  const allClips = [];
  let page = 0;
  while (true) {
    const body = {
      cursor: cursor,
      limit: 20,
      filters: {
        disliked: 'False',
        trashed: 'False',
        fromStudioProject: { presence: 'False' },
        stem: { presence: 'False' },
        stemComplement: 'False',
        workspace: { presence: 'True', workspaceId: workspaceId }
      }
    };
    const data = await fetchJson('https://studio-api-prod.suno.com/api/feed/v3', {
      method: 'POST',
      headers: h,
      body: JSON.stringify(body)
    });
    if (allClips.length === 0) {
      console.log('[SunoProv][DEBUG] feed/v3 first response keys:', Object.keys(data), 'has_more:', data.has_more ?? data.hasMore, 'next_cursor:', data.next_cursor ?? data.nextCursor, 'clips:', (data.clips || data.items || data.results || []).length, 'sample clip keys:', Object.keys((data.clips || data.items || data.results || [])[0] || {}).slice(0, 12));
    }
    const clips = data.clips || data.items || data.results || [];
    for (const clip of clips) {
      allClips.push(extractRow(clip, workspaceName));
    }
    if (onProgress) onProgress(allClips.length);
    const hasMore = data.has_more ?? data.hasMore ?? false;
    const next = data.next_cursor ?? data.nextCursor ?? data.cursor ?? null;
    if (!hasMore || !next) break;
    cursor = next;
    page++;
    await sleep(800);
  }
  return allClips;
}

// ── 4. Главная процедура сбора ───────────────────────────────────────────
async function collectProvenance(onProgress) {
  const headers = await getHeaders();
  if (!headers.authorization) {
    throw new Error('Токен не получен. Откройте suno.com и убедитесь что залогинены, затем попробуйте снова.');
  }

  const projects = await listAllProjects(headers);
  if (!projects.length) {
    throw new Error('Не найдено workspace (проектов). Проверьте что залогинены на suno.com');
  }

  // ── Чёрный список воркспейсов: ручной (по id) + авто по имени (подстрока) ──
  const DEFAULT_PATTERNS = [
    "My Workspace",
    "BOURREE TEST",
    "SCHERZO TEST",
    "TEST LAB",
    "LOOPS DUMP",
    "LOOPS STOCK",
    "Loops",
    "ТЕСТЫ",
    "Test",
    "My Experiment",
    "Каталог Жанров",
    "Renaissance Tests",
    "ROCK_BALLADS Seattle Grunge",
    "AMBIENT Harp",
    "Garage Fuzz N1",
    "Cinematic Collection N1"
  ];
  let AUTO_PATTERNS = [...DEFAULT_PATTERNS];
  try {
    const obj = await chrome.storage.local.get('customBlacklistPatterns');
    if (obj.customBlacklistPatterns) {
      const custom = obj.customBlacklistPatterns.split('\n').map(s => s.trim()).filter(Boolean);
      if (custom.length) AUTO_PATTERNS = custom;
    }
  } catch (_) {}
  let manualBlacklisted = [];
  try {
    const obj = await chrome.storage.local.get('blacklistedWorkspaces');
    manualBlacklisted = obj.blacklistedWorkspaces || [];
  } catch (_) {}
  const manualSet = new Set(manualBlacklisted);
  const isAutoBlacklisted = (name) => {
    if (!name) return false;
    const lower = name.toLowerCase();
    return AUTO_PATTERNS.some(p => lower.includes(p.toLowerCase()));
  };
  const filtered = projects.filter(p => {
    const id = p.id || p.project_id || p._id;
    const name = p.name || p.title || p.project_name || '';
    if (manualSet.has(id)) return false;
    if (isAutoBlacklisted(name)) return false;
    return true;
  });
  if (filtered.length !== projects.length) {
    const autoSkipped = projects.filter(p => isAutoBlacklisted(p.name || p.title || '')).length;
    console.log(`[SunoProv] blacklisted ${projects.length - filtered.length} workspace(s): manual=${manualBlacklisted.length} auto(pattern)=${autoSkipped}`);
  }

  const allRows = [];
  for (let i = 0; i < filtered.length; i++) {
    const p = filtered[i];
    const wsId = p.id || p.project_id || p._id;
    const wsName = p.name || p.title || p.project_name || `workspace_${wsId}`;
    if (!wsId) continue;
    if (onProgress) onProgress({ stage: 'workspace', current: i + 1, total: filtered.length, name: wsName });
    const clips = await fetchWorkspaceClips(headers, wsId, wsName, (count) => {
      if (onProgress) onProgress({ stage: 'clips', workspace: wsName, count });
    });
    allRows.push(...clips);
  }

  // Постобработка: flagged
  const byRoot = {};
  for (const r of allRows) {
    if (!byRoot[r.root_id]) byRoot[r.root_id] = [];
    byRoot[r.root_id].push(r);
  }
  const flagged = Object.entries(byRoot)
    .filter(([rootId, rows]) => new Set(rows.map(x => x.artist)).size > 1)
    .map(([rootId, rows]) => ({ rootId, artists: [...new Set(rows.map(x => x.artist))], count: rows.length }));

  return { rows: allRows, flagged };
}

// ── 5. Message handling ────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === 'collect') {
    (async () => {
      try {
        const result = await collectProvenance((progress) => {
          // шлём прогресс в popup (если он открыт)
          chrome.runtime.sendMessage({ type: 'PROGRESS', progress }).catch(() => {});
        });
        sendResponse({ ok: true, rows: result.rows, flagged: result.flagged });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true; // async
  }

  if (msg && msg.action === 'download') {
    const { csv, filename } = msg;
    const name = filename || 'suno_provenance.csv';
    const isJson = name.endsWith('.json');
    const mime = isJson ? 'application/json' : 'text/csv';
    const url = `data:${mime};charset=utf-8,` + encodeURIComponent(csv);
    chrome.downloads.download({ url, filename: name }, (id) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ ok: true, id });
      }
    });
    return true;
  }

  if (msg && msg.action === 'checkAuth') {
    getHeaders().then(h => {
      sendResponse({ ok: !!h.authorization, hasToken: !!h.authorization });
    }).catch(e => sendResponse({ ok: false, error: String(e) }));
    return true;
  }

  if (msg && msg.action === 'listProjects') {
    (async () => {
      try {
        const headers = await getHeaders();
        if (!headers.authorization) throw new Error('Токен не получен');
        const projects = await listAllProjects(headers);
        sendResponse({ ok: true, projects });
      } catch (e) {
        sendResponse({ ok: false, error: String(e && e.message || e) });
      }
    })();
    return true;
  }
});
