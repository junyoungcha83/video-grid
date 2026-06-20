// 비디오 그리드 — 로컬 동영상 6분할(3×2) 동시재생 + 동영상별 시작시간/이어보기 옵션.
// 전부 로컬 브라우저 전용. 파일은 서버/클라우드로 안 나감.

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogg|ogv|mkv|avi)$/i;
const LAYOUT_CELLS = { '1x2': 2, '2x2': 4, '3x2': 6, '3x3': 9 };

let videos = [];          // 불러온 전체 목록: {key,name,size,mtime, getFile()}
let cells = [];           // 칸 배정: VideoItem | null
let layout = '3x2';
let selectedCell = 0;     // 설정/목록배정 대상 칸
let currentSource = '';   // 'fsa' | 'input' — 마지막 불러오기 방식

// ── 동영상별 옵션 (localStorage) ──────────────────────
const fileKey = (f) => `${f.name}::${f.size}::${f.lastModified}`;
const optKey = (k) => `vg:opt:${k}`;
function getOpt(key) {
  try { return JSON.parse(localStorage.getItem(optKey(key)) || '{}'); } catch { return {}; }
}
function setOpt(key, o) { localStorage.setItem(optKey(key), JSON.stringify(o)); }

// ── 시간 파싱/표시 ────────────────────────────────────
function parseTime(s) {
  s = String(s || '').trim();
  if (!s) return null;
  if (/^\d+(\.\d+)?$/.test(s)) return parseFloat(s);
  const p = s.split(':').map(Number);
  if (p.some(isNaN)) return null;
  return p.reduce((a, v) => a * 60 + v, 0);
}
function fmtTime(sec) {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const mm = String(m).padStart(2, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// ── IndexedDB: File System Access 디렉터리 핸들 보존 ──
function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open('vg-fs', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('h');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
}
async function saveHandle(h, key = 'dir') { const db = await idb(); db.transaction('h', 'readwrite').objectStore('h').put(h, key); }
async function loadHandle(key = 'dir') { const db = await idb(); return new Promise(r => { const q = db.transaction('h', 'readonly').objectStore('h').get(key); q.onsuccess = () => r(q.result || null); q.onerror = () => r(null); }); }
async function deleteHandle(key) { const db = await idb(); db.transaction('h', 'readwrite').objectStore('h').delete(key); }
async function copyHandle(from, to) { const h = await loadHandle(from); if (h) await saveHandle(h, to); else await deleteHandle(to); }

// ── 파일 불러오기 ─────────────────────────────────────
function toItems(files) {
  return files.filter(f => f && (/(^video\/)/.test(f.type) || VIDEO_EXT.test(f.name)))
    .map(f => ({ key: fileKey(f), name: f.name, size: f.size, mtime: f.lastModified, _file: f, getFile: async () => f }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ko'));
}

// '폴더 열기' = 항상 새 폴더를 고르게(이전 폴더 재오픈 버그 방지) + 그 핸들을 최신으로 저장.
async function pickNewFolder() {
  try {
    const dir = await window.showDirectoryPicker();
    await saveHandle(dir);                 // 다음 실행 복원용으로 '최근' 폴더 갱신
    return await enumerateDir(dir);
  } catch (e) { return null; }             // 사용자가 취소
}

// 디렉터리 핸들 → 비디오 아이템 목록(key/size/mtime 채움)
async function enumerateDir(dir) {
  const items = [];
  for await (const [name, handle] of dir.entries()) {
    if (handle.kind === 'file' && VIDEO_EXT.test(name)) {
      items.push({ name, _handle: handle, key: null, getFile: async function () { return this._file || (this._file = await this._handle.getFile()); } });
    }
  }
  for (const it of items) { const f = await it.getFile(); it.key = fileKey(f); it.size = f.size; it.mtime = f.lastModified; }
  items.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return items;
}

async function loadVideos(items) {
  if (!items || !items.length) { setHint('동영상을 찾지 못했습니다.'); return; }
  videos = items;
  // 칸 자동 채움(앞에서부터)
  const n = LAYOUT_CELLS[layout];
  cells = Array.from({ length: n }, (_, i) => videos[i] || null);
  setHint(`${videos.length}개 불러옴`);
  saveSession();
  render();
}

// ── 격자 렌더 ─────────────────────────────────────────
const grid = document.getElementById('grid');
function render() {
  // 기존 URL 정리
  grid.querySelectorAll('video').forEach(v => { if (v.src) URL.revokeObjectURL(v.src); });
  grid.className = `grid layout-${layout}`;
  grid.innerHTML = '';
  cells.forEach((item, i) => grid.appendChild(makeTile(item, i)));
}

function makeTile(item, idx) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (item ? '' : ' empty');
  tile.dataset.idx = idx;
  if (!item) {
    tile.innerHTML = `<button class="add" title="이 칸에 영상 배정">＋</button>`;
    tile.querySelector('.add').onclick = () => { selectedCell = idx; openList(); };
    return tile;
  }
  const v = document.createElement('video');
  v.muted = true; v.loop = true; v.playsInline = true; v.preload = 'metadata';
  const opt = getOpt(item.key);
  if (typeof opt.vol === 'number') v.volume = opt.vol;
  item.getFile().then(f => {
    v.src = URL.createObjectURL(f);
    v.addEventListener('loadedmetadata', () => {
      const start = (opt.resume && typeof opt.pos === 'number') ? opt.pos
                  : (typeof opt.startSec === 'number') ? opt.startSec : 0;
      if (start > 0 && start < v.duration) { try { v.currentTime = start; } catch {} }
      v.play().catch(() => {});
    }, { once: true });
  });
  // 이어보기 저장(스로틀) + A-B 구간반복
  let lastSave = 0;
  v.addEventListener('timeupdate', () => {
    const o = getOpt(item.key);
    if (o.loopOn && typeof o.loopA === 'number' && typeof o.loopB === 'number' && o.loopB > o.loopA + 0.1) {
      if (v.currentTime >= o.loopB || v.currentTime < o.loopA - 0.4) { try { v.currentTime = o.loopA; } catch {} }
    }
    if (o.resume && Date.now() - lastSave > 3000) { lastSave = Date.now(); o.pos = v.currentTime; setOpt(item.key, o); }
  });

  const badge = document.createElement('div');
  badge.className = 'ab-badge';
  const bar = document.createElement('div');
  bar.className = 'tilebar';
  bar.innerHTML = `<span class="nm" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
    <span class="grow"></span>
    <button class="ic ab-a" title="구간 시작점 A (현재위치)">A</button>
    <button class="ic ab-b" title="구간 끝점 B (현재위치) → A–B 반복 시작">B</button>
    <button class="ic ab-t" title="구간반복 켜기/끄기">🔁</button>
    <button class="ic mute" title="소리(클릭=이 영상만)">🔇</button>
    <button class="ic gear" title="설정">⚙︎</button>
    <button class="ic close" title="이 칸 비우기">×</button>`;
  function refreshAB() {
    const o = getOpt(item.key);
    const has = typeof o.loopA === 'number' && typeof o.loopB === 'number' && o.loopB > o.loopA;
    bar.querySelector('.ab-a').classList.toggle('set', typeof o.loopA === 'number');
    bar.querySelector('.ab-b').classList.toggle('set', typeof o.loopB === 'number');
    bar.querySelector('.ab-t').classList.toggle('on', !!(o.loopOn && has));
    badge.classList.toggle('show', !!(o.loopOn && has));
    badge.textContent = has ? `🔁 ${fmtTime(o.loopA)}–${fmtTime(o.loopB)}` : '';
  }
  bar.querySelector('.ab-a').onclick = (e) => { e.stopPropagation(); const o = getOpt(item.key); o.loopA = +v.currentTime.toFixed(2); setOpt(item.key, o); refreshAB(); };
  bar.querySelector('.ab-b').onclick = (e) => { e.stopPropagation(); const o = getOpt(item.key); o.loopB = +v.currentTime.toFixed(2); if (typeof o.loopA === 'number' && o.loopB > o.loopA) o.loopOn = true; setOpt(item.key, o); refreshAB(); };
  bar.querySelector('.ab-t').onclick = (e) => { e.stopPropagation(); const o = getOpt(item.key); o.loopOn = !o.loopOn; setOpt(item.key, o); refreshAB(); if (o.loopOn && typeof o.loopA === 'number') { try { v.currentTime = o.loopA; } catch {} } };
  bar.querySelector('.mute').onclick = (e) => { e.stopPropagation(); soloAudio(idx); };
  bar.querySelector('.gear').onclick = (e) => { e.stopPropagation(); openOpt(idx); };
  bar.querySelector('.close').onclick = (e) => { e.stopPropagation(); cells[idx] = null; saveSession(); render(); };

  tile.appendChild(v);
  tile.appendChild(badge);
  tile.appendChild(bar);
  refreshAB();
  tile.addEventListener('click', () => soloAudio(idx));        // 타일 클릭 = 그 영상만 소리
  tile.addEventListener('dblclick', () => v.requestFullscreen?.());
  return tile;
}

// 한 영상만 소리(나머지 음소거)
function soloAudio(idx) {
  grid.querySelectorAll('.tile').forEach((t, i) => {
    const v = t.querySelector('video'); if (!v) return;
    const on = (i === idx);
    v.muted = !on;
    t.classList.toggle('audio-on', on);
    t.querySelector('.mute') && (t.querySelector('.mute').textContent = on ? '🔊' : '🔇');
  });
}

// ── 목록 오버레이(불러온 영상 → 칸 배정) ─────────────
const listOv = document.getElementById('listOverlay');
function openList() {
  document.getElementById('listCount').textContent = videos.length;
  const lg = document.getElementById('listGrid');
  lg.innerHTML = videos.map((v, i) =>
    `<button class="li" data-i="${i}"><span class="li-nm">${escapeHtml(v.name)}</span></button>`).join('') || '<p class="muted">불러온 영상이 없습니다. 상단 "폴더 열기"로 불러오세요.</p>';
  lg.querySelectorAll('.li').forEach(b => b.onclick = () => {
    cells[selectedCell] = videos[+b.dataset.i];
    saveSession(); render(); closeOverlays();
  });
  listOv.classList.remove('hidden');
}

// ── 설정 오버레이 ─────────────────────────────────────
let optTargetIdx = -1;
function openOpt(idx) {
  const item = cells[idx]; if (!item) return;
  optTargetIdx = idx;
  const o = getOpt(item.key);
  document.getElementById('optTitle').textContent = item.name;
  document.getElementById('optStart').value = (typeof o.startSec === 'number') ? fmtTime(o.startSec) : '';
  document.getElementById('optResume').checked = !!o.resume;
  document.getElementById('optVol').value = (typeof o.vol === 'number') ? o.vol : 1;
  document.getElementById('optOverlay').classList.remove('hidden');
}
document.getElementById('optStartNow').onclick = () => {
  const v = curVideo(optTargetIdx); if (v) document.getElementById('optStart').value = fmtTime(v.currentTime);
};
document.getElementById('optSave').onclick = () => {
  const item = cells[optTargetIdx]; if (!item) return;
  const o = getOpt(item.key);
  o.startSec = parseTime(document.getElementById('optStart').value);
  if (o.startSec == null) delete o.startSec;
  o.resume = document.getElementById('optResume').checked;
  o.vol = parseFloat(document.getElementById('optVol').value);
  setOpt(item.key, o);
  const v = curVideo(optTargetIdx);
  if (v) { v.volume = o.vol; if (typeof o.startSec === 'number' && o.startSec < v.duration) { try { v.currentTime = o.startSec; } catch {} } }
  closeOverlays();
};
document.getElementById('optClear').onclick = () => {
  const item = cells[optTargetIdx]; if (item) localStorage.removeItem(optKey(item.key));
  closeOverlays();
};
function curVideo(idx) { const t = grid.querySelector(`.tile[data-idx="${idx}"]`); return t ? t.querySelector('video') : null; }

// ── 세션(최근) 저장/복원 ──────────────────────────────
function saveSession() {
  localStorage.setItem('vg:session', JSON.stringify({ layout, cellKeys: cells.map(c => c ? c.key : null), source: currentSource, count: videos.length }));
}
function loadSessionRaw() { try { return JSON.parse(localStorage.getItem('vg:session') || '{}'); } catch { return {}; } }
function restoreSessionInto() {
  try {
    const s = JSON.parse(localStorage.getItem('vg:session') || '{}');
    if (s.layout && LAYOUT_CELLS[s.layout]) { layout = s.layout; setLayoutUI(); }
    if (Array.isArray(s.cellKeys) && videos.length) {
      const byKey = Object.fromEntries(videos.map(v => [v.key, v]));
      cells = s.cellKeys.slice(0, LAYOUT_CELLS[layout]).map(k => byKey[k] || null);
      while (cells.length < LAYOUT_CELLS[layout]) cells.push(null);
    }
  } catch {}
}

// ── 상단바/레이아웃/전체 컨트롤 ───────────────────────
function setLayoutUI() {
  document.querySelectorAll('#layoutSeg button').forEach(b => b.classList.toggle('on', b.dataset.layout === layout));
}
document.getElementById('layoutSeg').onclick = (e) => {
  const b = e.target.closest('button[data-layout]'); if (!b) return;
  layout = b.dataset.layout; setLayoutUI();
  const n = LAYOUT_CELLS[layout];
  cells = Array.from({ length: n }, (_, i) => cells[i] || videos[i] || null);
  saveSession(); render();
};
document.getElementById('btnFolder').onclick = async () => {
  if (window.showDirectoryPicker) {                 // 데스크톱 Chrome/Edge: 항상 새 폴더 선택
    setHint('폴더 선택…'); const items = await pickNewFolder();
    if (items) { currentSource = 'fsa'; restoreFromSettingsThenLoad(items); } else setHint('');
  } else {                                            // 그 외: webkitdirectory 폴더 input(데스크톱) — 모바일은 "파일 선택" 권장
    document.getElementById('dirPick').click();
  }
};
// ── 설정 슬롯 A/B/C (각자 비밀번호 선택) ─────────────
const SLOTS = ['A', 'B', 'C'];
function slotMeta(s) { try { return JSON.parse(localStorage.getItem('vg:slot:' + s) || 'null'); } catch { return null; } }
function slotPw(s) { return localStorage.getItem('vg:pw:' + s) || ''; }
async function pwHash(str) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('vg-salt:' + str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
}
function updateSlotUI() {
  document.querySelectorAll('.slot').forEach(btn => {
    const s = btn.dataset.slot, meta = slotMeta(s), locked = !!slotPw(s);
    btn.classList.toggle('has', !!meta);
    btn.classList.toggle('locked', locked);
    btn.textContent = (locked ? '🔒' : '') + s;
    btn.title = meta ? `슬롯 ${s} · ${meta.count || 0}개${locked ? ' · 비번잠금' : ''} (누르기=불러오기 · 길게=관리)`
                     : `슬롯 ${s} 비어있음 (누르기=현재 상태 저장 · 길게=관리)`;
  });
}
async function saveSlot(s) {
  if (!videos.length) { setHint('먼저 폴더/파일을 불러온 뒤 저장하세요'); return; }
  saveSession();                                                  // 현재 상태를 vg:session에 스냅샷
  localStorage.setItem('vg:slot:' + s, localStorage.getItem('vg:session') || '{}');
  if (currentSource === 'fsa') await copyHandle('dir', 'dir:' + s); else await deleteHandle('dir:' + s);
  updateSlotUI(); setHint(`슬롯 ${s}에 저장됨${slotPw(s) ? ' (비번잠금)' : ''}`);
}
async function loadSlot(s) {
  const meta = slotMeta(s);
  if (!meta) { setHint(`슬롯 ${s}는 비어있습니다`); return; }
  const pw = slotPw(s);
  if (pw) {
    const inp = prompt(`슬롯 ${s} 비밀번호를 입력하세요`);
    if (inp === null) return;
    if (await pwHash(inp) !== pw) { alert('비밀번호가 틀렸습니다.'); return; }
  }
  localStorage.setItem('vg:session', JSON.stringify(meta));       // 이 슬롯을 현재 세션으로
  await copyHandle('dir:' + s, 'dir');
  await restoreSession();
}
async function setSlotPassword(s) {
  const pw = prompt(`슬롯 ${s} 비밀번호 설정\n(빈칸으로 두면 잠금 해제 — 누구나 불러오기 가능)`, '');
  if (pw === null) return;
  if (pw === '') { localStorage.removeItem('vg:pw:' + s); setHint(`슬롯 ${s} 잠금 해제됨`); }
  else { localStorage.setItem('vg:pw:' + s, await pwHash(pw)); setHint(`슬롯 ${s} 비밀번호 설정됨 🔒`); }
  updateSlotUI();
}
function deleteSlot(s) {
  if (!slotMeta(s) && !slotPw(s)) { setHint(`슬롯 ${s}는 이미 비어있습니다`); return; }
  if (!confirm(`슬롯 ${s}의 저장 내용과 비밀번호를 삭제할까요?`)) return;
  localStorage.removeItem('vg:slot:' + s); localStorage.removeItem('vg:pw:' + s);
  deleteHandle('dir:' + s); updateSlotUI(); setHint(`슬롯 ${s} 삭제됨`);
}
// 슬롯 버튼: 짧게=불러오기(빈칸은 저장) · 길게=관리 메뉴
const slotMenu = document.getElementById('slotMenu');
let menuSlot = null;
document.querySelectorAll('.slot').forEach(btn => {
  const s = btn.dataset.slot;
  let timer = null, longPressed = false;
  const start = () => { longPressed = false; timer = setTimeout(() => { longPressed = true; openSlotMenu(s, btn); }, 500); };
  const cancel = () => { clearTimeout(timer); };
  btn.addEventListener('pointerdown', start);
  btn.addEventListener('pointerup', () => { cancel(); if (longPressed) return; slotMeta(s) ? loadSlot(s) : saveSlot(s); });
  btn.addEventListener('pointerleave', cancel);
  btn.addEventListener('contextmenu', e => { e.preventDefault(); openSlotMenu(s, btn); });
});
function openSlotMenu(s, btn) {
  menuSlot = s;
  document.getElementById('smName').textContent = s;
  const r = btn.getBoundingClientRect();
  slotMenu.style.left = Math.min(r.left, innerWidth - 200) + 'px';
  slotMenu.style.top = (r.bottom + 6) + 'px';
  slotMenu.classList.remove('hidden');
}
function closeSlotMenu() { slotMenu.classList.add('hidden'); menuSlot = null; }
slotMenu.querySelectorAll('button').forEach(b => b.onclick = async () => {
  const s = menuSlot, act = b.dataset.act; closeSlotMenu();
  if (act === 'load') loadSlot(s);
  else if (act === 'save') saveSlot(s);
  else if (act === 'pw') setSlotPassword(s);
  else if (act === 'del') deleteSlot(s);
});
document.addEventListener('pointerdown', e => { if (!slotMenu.contains(e.target) && !e.target.closest('.slot')) closeSlotMenu(); });
document.getElementById('dirPick').onchange = (e) => { const items = toItems([...e.target.files]); if (items.length) { currentSource = 'input'; restoreFromSettingsThenLoad(items); } e.target.value = ''; };
document.getElementById('filePick').onchange = (e) => { const items = toItems([...e.target.files]); if (items.length) { currentSource = 'input'; restoreFromSettingsThenLoad(items); } e.target.value = ''; };
document.getElementById('btnPlayAll').onclick = () => grid.querySelectorAll('video').forEach(v => v.play().catch(() => {}));
document.getElementById('btnPauseAll').onclick = () => grid.querySelectorAll('video').forEach(v => v.pause());
document.getElementById('btnPickList').onclick = () => { selectedCell = cells.findIndex(c => !c); if (selectedCell < 0) selectedCell = 0; openList(); };
document.getElementById('btnHideBar').onclick = () => document.body.classList.toggle('bar-hidden');
document.querySelectorAll('[data-close]').forEach(b => b.onclick = closeOverlays);
[listOv, document.getElementById('optOverlay')].forEach(ov => ov.addEventListener('click', e => { if (e.target === ov) closeOverlays(); }));
function closeOverlays() { listOv.classList.add('hidden'); document.getElementById('optOverlay').classList.add('hidden'); }

// 불러온 뒤, 저장된 세션(배치)이 있으면 반영
function restoreFromSettingsThenLoad(items) {
  videos = items;
  setHint(`${videos.length}개 불러옴`);
  restoreSessionInto();
  if (!cells.length || cells.every(c => !c)) {
    const n = LAYOUT_CELLS[layout];
    cells = Array.from({ length: n }, (_, i) => videos[i] || null);
  }
  saveSession(); render();
}

// 키보드: H=바숨김, Space=전체 토글
document.addEventListener('keydown', (e) => {
  if (e.target.tagName === 'INPUT') return;
  if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('bar-hidden');
  if (e.code === 'Space') { e.preventDefault(); const anyPlaying = [...grid.querySelectorAll('video')].some(v => !v.paused); grid.querySelectorAll('video').forEach(v => anyPlaying ? v.pause() : v.play().catch(() => {})); }
});
window.addEventListener('beforeunload', () => {
  grid.querySelectorAll('.tile').forEach((t) => { const v = t.querySelector('video'); const idx = +t.dataset.idx; const item = cells[idx]; if (v && item) { const o = getOpt(item.key); if (o.resume) { o.pos = v.currentTime; setOpt(item.key, o); } } });
});

function setHint(s) { document.getElementById('hint').textContent = s || ''; }
function escapeHtml(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }

// 시작 시 복원 배너(중앙)
function showRestoreBanner(text, onClick) {
  document.getElementById('restoreBanner')?.remove();
  const b = document.createElement('div');
  b.id = 'restoreBanner'; b.className = 'restore-banner';
  b.innerHTML = `<button class="rb-btn"></button><button class="rb-x" title="닫기">×</button>`;
  b.querySelector('.rb-btn').textContent = text;
  document.body.appendChild(b);
  b.querySelector('.rb-btn').onclick = async () => { b.remove(); try { await onClick(); } catch {} };
  b.querySelector('.rb-x').onclick = () => b.remove();
}

// 저장된 세션 복원 (시작 시 + 📂 불러오기 버튼). FSA 권한 있으면 자동, 없으면 1클릭/파일 재선택.
async function restoreSession() {
  const sess = loadSessionRaw();
  if (sess.layout && LAYOUT_CELLS[sess.layout]) { layout = sess.layout; setLayoutUI(); cells = Array.from({ length: LAYOUT_CELLS[layout] }, () => null); render(); }
  let dir = null; try { dir = await loadHandle(); } catch {}
  if (dir) {
    let perm = 'prompt'; try { perm = await dir.queryPermission({ mode: 'read' }); } catch {}
    if (perm === 'granted') {
      try {
        const items = await enumerateDir(dir);
        if (items.length) { currentSource = 'fsa'; setHint('이전 폴더 복원됨'); restoreFromSettingsThenLoad(items); return; }
      } catch {}
    }
    showRestoreBanner(`📂 이전 폴더 다시 열기${sess.count ? ` · ${sess.count}개` : ''}`, async () => {
      try { if ((await dir.requestPermission({ mode: 'read' })) !== 'granted') { setHint('폴더 접근 권한 거부됨'); return; } } catch { return; }
      const items = await enumerateDir(dir);
      if (items.length) { currentSource = 'fsa'; restoreFromSettingsThenLoad(items); }
    });
    return;
  }
  if (Array.isArray(sess.cellKeys) && sess.cellKeys.some(Boolean)) {
    showRestoreBanner('📄 이전 파일 다시 선택 (같은 칸 자동 복원)', () => document.getElementById('filePick').click());
  } else {
    setHint('저장된 세션이 없습니다 — 폴더/파일을 불러오세요');
  }
}

// 초기 실행
(async () => {
  if (!window.showDirectoryPicker) document.getElementById('btnFolder').title = '폴더 기억 미지원 — "파일 선택" 사용';
  cells = Array.from({ length: LAYOUT_CELLS[layout] }, () => null);
  render();
  updateSlotUI();
  const filled = SLOTS.filter(s => slotMeta(s));
  setHint(filled.length ? `슬롯 ${filled.join('/')} 저장됨 — 눌러서 불러오기` : '폴더/파일을 불러온 뒤 A·B·C에 저장하세요');
})();
