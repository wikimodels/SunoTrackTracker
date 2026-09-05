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
