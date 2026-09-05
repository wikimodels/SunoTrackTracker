// popup.js
let lastRows = [];
let lastFlagged = [];

const els = {
  auth: document.getElementById('auth'),
  btnCollect: document.getElementById('btn-collect'),
  progress: document.getElementById('progress'),
  status: document.getElementById('status'),
  flagged: document.getElementById('flagged'),
  downloadRow: document.getElementById('download-row'),
  btnCsv: document.getElementById('btn-csv'),
  btnJson: document.getElementById('btn-json'),
};

async function checkAuth() {
  try {
    const resp = await chrome.runtime.sendMessage({ action: 'checkAuth' });
    if (resp && resp.hasToken) {
      els.auth.className = 'auth ok';
      els.auth.textContent = '● Токен получен — готов к сбору';
    } else {
      els.auth.className = 'auth bad';
      els.auth.textContent = '● Токен не найден — откройте suno.com и обновите страницу';
    }
  } catch (_) {
    els.auth.className = 'auth bad';
    els.auth.textContent = '● Не удалось проверить токен';
  }
}

function setStatus(msg) {
  els.status.textContent = msg;
}

function setProgress(msg) {
  els.progress.textContent = msg;
}

els.btnCollect.addEventListener('click', async () => {
  els.btnCollect.disabled = true;
  els.btnCollect.textContent = 'Собираю…';
  els.flagged.classList.add('hidden');
  els.downloadRow.classList.add('hidden');
  setStatus('Старт сбора…');
  setProgress('');

  // Слушаем прогресс
  const onProgress = (msg) => {
    if (msg.type === 'PROGRESS' && msg.progress) {
      const p = msg.progress;
      if (p.stage === 'workspace') {
        setProgress(`Workspace ${p.current}/${p.total}: ${p.name}`);
      } else if (p.stage === 'clips') {
        setProgress(`  ${p.workspace}: ${p.count} клипов…`);
      }
    }
  };
  chrome.runtime.onMessage.addListener(onProgress);

  try {
    const resp = await chrome.runtime.sendMessage({ action: 'collect' });
    chrome.runtime.onMessage.removeListener(onProgress);

    if (!resp.ok) {
      setStatus('Ошибка: ' + resp.error);
      els.auth.className = 'auth bad';
      return;
    }

    lastRows = resp.rows || [];
    lastFlagged = resp.flagged || [];

    setStatus(`Готово — собрано ${lastRows.length} клипов в ${[...new Set(lastRows.map(r=>r.workspace))].length} workspace`);
    setProgress('');

    if (lastFlagged.length) {
      els.flagged.classList.remove('hidden');
      els.flagged.innerHTML = `<b>Найдено ${lastFlagged.length} root_id с разными артистами</b> — кандидаты на маркировку "Cover of …" при дистрибуции:<br>` +
        lastFlagged.slice(0, 5).map(f => `• ${f.rootId.slice(0,8)}… — ${f.artists.join(' / ')} (${f.count})`).join('<br>') +
        (lastFlagged.length > 5 ? `<br>… и ещё ${lastFlagged.length - 5}` : '');
    } else {
      els.flagged.classList.remove('hidden');
      els.flagged.textContent = 'Флагованных root_id не найдено — кросс-артист каверов нет.';
      els.flagged.style.background = 'rgba(34,197,94,0.08)';
      els.flagged.style.borderColor = 'rgba(34,197,94,0.2)';
      els.flagged.style.color = '#4ade80';
    }

    els.downloadRow.classList.remove('hidden');

  } catch (e) {
    chrome.runtime.onMessage.removeListener(onProgress);
    setStatus('Ошибка: ' + String(e && e.message || e));
  } finally {
    els.btnCollect.disabled = false;
    els.btnCollect.textContent = 'Собрать provenance';
  }
});

const AUTO_PATTERNS = [
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
function isAutoBlacklisted(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return AUTO_PATTERNS.some(p => lower.includes(p.toLowerCase()));
}

async function loadBlacklist() {
  const obj = await chrome.storage.local.get('blacklistedWorkspaces');
  return obj.blacklistedWorkspaces || [];
}

async function saveBlacklist(list) {
  await chrome.storage.local.set({ blacklistedWorkspaces: list });
}

async function renderBlacklist() {
  const container = document.getElementById('blacklist-list');
  if (!container) return;
  container.innerHTML = '<span style="font-size:11px; color:#475569;">Загрузка…</span>';
  try {
    // пробуем получить список проектов через background
    const resp = await chrome.runtime.sendMessage({ action: 'listProjects' });
    if (!resp || !resp.ok) {
      container.innerHTML = `<span style="font-size:11px; color:#f87171;">${resp ? resp.error : 'Нет ответа'}</span>`;
      return;
    }
    const blacklisted = new Set(await loadBlacklist());
    const projects = resp.projects || [];
    if (!projects.length) {
      container.innerHTML = '<span style="font-size:11px; color:#475569;">Нет workspace</span>';
      return;
    }
    container.innerHTML = projects.map(p => {
      const id = p.id || p.project_id || p._id || '';
      const name = p.name || p.title || id;
      const isAuto = isAutoBlacklisted(name);
      const isManual = blacklisted.has(id);
      const checked = (isAuto || isManual) ? 'checked' : '';
      const disabled = isAuto ? 'disabled' : '';
      const bg = isAuto ? 'rgba(251,191,36,0.08)' : (isManual ? 'rgba(239,68,68,0.08)' : 'transparent');
      const border = isAuto ? 'rgba(251,191,36,0.25)' : (isManual ? 'rgba(239,68,68,0.15)' : 'transparent');
      const badge = isAuto ? '<span style="font-size:9px; background:rgba(251,191,36,0.15); color:#fbbf24; padding:1px 4px; border-radius:4px;">auto</span>' : '';
      return `<label style="display:flex; align-items:center; gap:8px; font-size:11px; color:#cbd5e1; cursor:pointer; padding:4px 6px; border-radius:6px; background:${bg}; border:1px solid ${border};">
        <input type="checkbox" data-ws-id="${id}" ${checked} ${disabled} style="accent-color:${isAuto ? '#fbbf24' : '#ef4444'};"> <span style="flex:1; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${name}</span> ${badge} <span style="font-size:10px; opacity:0.5;">${id.slice(0,6)}…</span>
      </label>`;
    }).join('');
    container.querySelectorAll('input[type="checkbox"]').forEach(cb => {
      cb.addEventListener('change', async () => {
        const id = cb.dataset.wsId;
        let list = await loadBlacklist();
        if (cb.checked) { if (!list.includes(id)) list.push(id); }
        else { list = list.filter(x => x !== id); }
        await saveBlacklist(list);
        cb.closest('label').style.background = cb.checked ? 'rgba(239,68,68,0.08)' : 'transparent';
        cb.closest('label').style.borderColor = cb.checked ? 'rgba(239,68,68,0.15)' : 'transparent';
      });
    });
  } catch (e) {
    container.innerHTML = `<span style="font-size:11px; color:#f87171;">Ошибка: ${String(e.message || e).slice(0,120)}</span>`;
  }
}

async function loadCustomPatterns() {
  const obj = await chrome.storage.local.get('customBlacklistPatterns');
  return obj.customBlacklistPatterns || AUTO_PATTERNS.join('\n');
}
async function saveCustomPatterns(text) {
  const patterns = text.split('\n').map(s => s.trim()).filter(Boolean);
  await chrome.storage.local.set({ customBlacklistPatterns: patterns.join('\n') });
  return patterns;
}
async function initPatternsTextarea() {
  const ta = document.getElementById('blacklist-patterns');
  if (!ta) return;
  const obj = await chrome.storage.local.get('customBlacklistPatterns');
  ta.value = obj.customBlacklistPatterns || AUTO_PATTERNS.join('\n');
}
document.getElementById('btn-blacklist-save')?.addEventListener('click', async () => {
  const ta = document.getElementById('blacklist-patterns');
  if (!ta) return;
  await saveCustomPatterns(ta.value);
  // также обновим AUTO_PATTERNS в памяти для текущего popup
  const newPatterns = ta.value.split('\n').map(s => s.trim()).filter(Boolean);
  AUTO_PATTERNS.length = 0;
  AUTO_PATTERNS.push(...newPatterns);
  renderBlacklist();
  setStatus('Чёрный список сохранён');
});

document.getElementById('btn-blacklist-refresh')?.addEventListener('click', renderBlacklist);
document.getElementById('btn-blacklist-clear')?.addEventListener('click', async () => {
  await saveBlacklist([]);
  // сбросить кастомные паттерны к дефолту
  await chrome.storage.local.remove('customBlacklistPatterns');
  const ta = document.getElementById('blacklist-patterns');
  if (ta) ta.value = AUTO_PATTERNS.join('\n');
  renderBlacklist();
});

function toCsv(rows) {
  if (!rows.length) return '';
  const cols = Object.keys(rows[0]);
  const esc = v => {
    const s = String(v ?? '');
    if (s.includes(',') || s.includes('"') || s.includes('\n')) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  };
  return [cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n');
}

els.btnCsv.addEventListener('click', () => {
  if (!lastRows.length) return;
  const csv = toCsv(lastRows);
  chrome.runtime.sendMessage({ action: 'download', csv, filename: 'suno_provenance.csv' }, (resp) => {
    if (resp && !resp.ok) setStatus('Ошибка скачивания: ' + resp.error);
  });
});

els.btnJson.addEventListener('click', () => {
  if (!lastRows.length) return;
  const json = JSON.stringify({ rows: lastRows, flagged: lastFlagged }, null, 2);
  const csv = json; // reuse download path
  chrome.runtime.sendMessage({ action: 'download', csv, filename: 'suno_provenance.json' }, (resp) => {
    if (resp && !resp.ok) setStatus('Ошибка скачивания: ' + resp.error);
  });
  // Для JSON нужен другой mime, но data: URL с csv всё равно скачается как текст — для простоты делаем csv путь с json контентом
  // На самом деле background ожидает csv, но для JSON это тоже сработает как текст
});

checkAuth();
renderBlacklist();
initPatternsTextarea();
