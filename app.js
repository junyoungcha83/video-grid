// 비디오 그리드 — 로컬 동영상 6분할(3×2) 동시재생 + 동영상별 시작시간/이어보기 옵션.
// 전부 로컬 브라우저 전용. 파일은 서버/클라우드로 안 나감.

const VIDEO_EXT = /\.(mp4|m4v|webm|mov|ogg|ogv|mkv|avi)$/i;
const LAYOUT_CELLS = { '1x2': 2, '2x2': 4, '3x2': 6, '3x3': 9 };
// File System Access API 의 accept 는 와일드카드('video/*') 불가 → 구체 MIME 사용.
const PICKER_TYPES = [{
  description: '동영상',
  accept: {
    'video/mp4': ['.mp4', '.m4v'],
    'video/webm': ['.webm'],
    'video/quicktime': ['.mov'],
    'video/x-matroska': ['.mkv'],
    'video/x-msvideo': ['.avi'],
    'video/ogg': ['.ogv', '.ogg'],
  },
}];

let videos = [];          // 불러온 전체 목록: {key,name,size,mtime, getFile()}
let cells = [];           // 칸 배정: VideoItem | null
let layout = '3x2';
let selectedCell = 0;     // 설정/목록배정 대상 칸
let currentSource = '';   // 'fsa' | 'input' — 마지막 불러오기 방식

// ── 동영상별 옵션 (localStorage) ──────────────────────
// 파일 식별 key — 이동/원복해도 유지되도록 mtime 제외(name+size). 같은 폴더로 원복 시 재매칭됨.
const fileKey = (f) => `${f.name}::${f.size}`;
// 옛 key(name::size::mtime) 도 name::size 로 정규화해 하위호환 매칭
const normKey = (k) => String(k || '').split('::').slice(0, 2).join('::');
const optKey = (k) => `vg:opt:${normKey(k)}`;
function getOpt(key) {
  try {
    let raw = localStorage.getItem(optKey(key));
    if (!raw) {                                          // 구버전 옵션(vg:opt:name::size::mtime) 흡수
      const prefix = optKey(key) + '::';
      for (let i = 0; i < localStorage.length; i++) {
        const lk = localStorage.key(i);
        if (lk && lk.startsWith(prefix)) { raw = localStorage.getItem(lk); localStorage.setItem(optKey(key), raw); localStorage.removeItem(lk); break; }
      }
    }
    return JSON.parse(raw || '{}');
  } catch { return {}; }
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
// 두 저장 핸들(폴더 or 파일배열)이 같은 대상을 가리키는지
async function sameHandle(a, b) {
  if (!a || !b) return false;
  const arrA = Array.isArray(a), arrB = Array.isArray(b);
  if (arrA !== arrB) return false;
  try {
    if (arrA) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) if (!(await a[i].isSameEntry(b[i]))) return false;
      return true;
    }
    return await a.isSameEntry(b);
  } catch { return false; }
}

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

// 저장된 핸들(디렉터리 또는 파일핸들 배열) → 아이템 목록
function itemFromFileHandle(h) {
  return { name: h.name, _handle: h, key: null, getFile: async function () { return this._file || (this._file = await this._handle.getFile()); } };
}
async function itemsFromStored(stored) {
  if (!stored) return null;
  if (!Array.isArray(stored) && stored.kind === 'directory') return enumerateDir(stored);
  const handles = Array.isArray(stored) ? stored : [stored];
  const items = handles.filter(h => h && h.kind === 'file').map(itemFromFileHandle);
  for (const it of items) { const f = await it.getFile(); it.key = fileKey(f); it.size = f.size; it.mtime = f.lastModified; }
  items.sort((a, b) => a.name.localeCompare(b.name, 'ko'));
  return items;
}
// 권한 조회/요청 (디렉터리=핸들1개, 파일배열=각 핸들)
async function permState(stored) {
  for (const h of (Array.isArray(stored) ? stored : [stored])) {
    try { if ((await h.queryPermission({ mode: 'read' })) !== 'granted') return 'prompt'; } catch { return 'prompt'; }
  }
  return 'granted';
}
async function requestPermFor(stored) {
  for (const h of (Array.isArray(stored) ? stored : [stored])) {
    try { if ((await h.requestPermission({ mode: 'read' })) !== 'granted') return false; } catch { return false; }
  }
  return true;
}
// '파일 선택'을 핸들 기반으로(가능 시) → 재선택 없이 슬롯 복원 가능
async function pickFiles() {
  try {
    const handles = await window.showOpenFilePicker({ multiple: true, types: PICKER_TYPES });
    if (!handles || !handles.length) return null;
    await saveHandle(handles);             // 파일핸들 배열을 '최근'으로 저장
    return await itemsFromStored(handles);
  } catch (e) { return null; }             // 사용자가 취소
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
    tile.innerHTML = `<button class="add" title="이 칸에 동영상 파일 추가">＋</button>`;
    tile.querySelector('.add').onclick = () => { addFileToCell(idx); };
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
  const dur = () => (isFinite(v.duration) ? v.duration : 0);

  // ── 하단 바: 타임라인(전체길이 표시 + 드래그로 위치/구간 지정) + 컨트롤 ──
  const bar = document.createElement('div');
  bar.className = 'tilebar';
  bar.innerHTML = `
    <div class="seekrow">
      <span class="t-cur">0:00</span>
      <div class="seek">
        <div class="seek-region"></div>
        <div class="seek-played"></div>
        <div class="seek-hand sa" title="구간 시작 A — 드래그"></div>
        <div class="seek-hand sb" title="구간 끝 B — 드래그"></div>
      </div>
      <span class="t-dur">0:00</span>
    </div>
    <div class="btnrow">
      <span class="nm" title="${escapeHtml(item.name)}">${escapeHtml(item.name)}</span>
      <span class="grow"></span>
      <button class="ic ab-t" title="구간반복 켜기/끄기">🔁</button>
      <button class="ic ab-clr" title="구간 해제">⤫</button>
      <button class="ic mute" title="소리 켜기/끄기(토글)">🔇</button>
      <button class="ic gear" title="설정">⚙︎</button>
      <button class="ic close" title="이 칸 비우기">×</button>
    </div>`;
  const seek = bar.querySelector('.seek');
  const elRegion = bar.querySelector('.seek-region'), elPlayed = bar.querySelector('.seek-played');
  const elA = bar.querySelector('.sa'), elB = bar.querySelector('.sb');
  const elCur = bar.querySelector('.t-cur'), elDur = bar.querySelector('.t-dur');

  function ab() { const o = getOpt(item.key), d = dur();
    return { o, d, A: (typeof o.loopA === 'number') ? o.loopA : 0, B: (typeof o.loopB === 'number') ? o.loopB : d }; }
  function layoutSeek() {
    const { o, d, A, B } = ab(); if (!d) return;
    const pa = Math.max(0, Math.min(1, A / d)) * 100, pb = Math.max(0, Math.min(1, B / d)) * 100;
    elA.style.left = pa + '%'; elB.style.left = pb + '%';
    elRegion.style.left = pa + '%'; elRegion.style.width = Math.max(0, pb - pa) + '%';
    const active = !!o.loopOn && B > A;
    seek.classList.toggle('looping', active);
    bar.querySelector('.ab-t').classList.toggle('on', active);
    elDur.textContent = fmtTime(d);
  }
  function playhead() { const d = dur(); if (!d) return;
    elPlayed.style.width = Math.min(100, v.currentTime / d * 100) + '%'; elCur.textContent = fmtTime(v.currentTime); }

  v.addEventListener('loadedmetadata', () => { layoutSeek(); playhead(); });
  v.addEventListener('durationchange', () => { layoutSeek(); });   // webm 등 길이 나중 확정 대응

  const fracFromX = (x) => { const r = seek.getBoundingClientRect(); return Math.min(1, Math.max(0, (x - r.left) / r.width)); };
  function dragHandler(kind) {
    return (e) => {
      e.preventDefault(); e.stopPropagation();
      const move = (ev) => {
        const d = dur(); if (!d) return;
        const t = fracFromX(ev.clientX) * d, o = getOpt(item.key);
        if (kind === 'seek') { try { v.currentTime = t; } catch {} playhead(); return; }
        if (kind === 'a') { const B = (typeof o.loopB === 'number') ? o.loopB : d; o.loopA = Math.min(t, B - 0.2); o.loopOn = true; }
        else { const A = (typeof o.loopA === 'number') ? o.loopA : 0; o.loopB = Math.max(t, A + 0.2); o.loopOn = true; }
        setOpt(item.key, o); layoutSeek();
      };
      move(e);
      const up = () => { document.removeEventListener('pointermove', move); document.removeEventListener('pointerup', up); };
      document.addEventListener('pointermove', move); document.addEventListener('pointerup', up);
    };
  }
  seek.addEventListener('pointerdown', dragHandler('seek'));
  elA.addEventListener('pointerdown', dragHandler('a'));
  elB.addEventListener('pointerdown', dragHandler('b'));

  bar.addEventListener('click', (e) => e.stopPropagation());   // 바 조작은 타일 solo로 안 번지게
  bar.querySelector('.ab-t').onclick = () => { const o = getOpt(item.key); o.loopOn = !o.loopOn; setOpt(item.key, o); layoutSeek(); if (o.loopOn) { try { v.currentTime = ab().A; } catch {} } };
  bar.querySelector('.ab-clr').onclick = () => { const o = getOpt(item.key); delete o.loopA; delete o.loopB; o.loopOn = false; setOpt(item.key, o); layoutSeek(); };
  bar.querySelector('.mute').onclick = () => toggleAudio(idx);
  bar.querySelector('.gear').onclick = () => openOpt(idx);
  bar.querySelector('.close').onclick = () => { cells[idx] = null; saveSession(); render(); };

  // 재생 위치 갱신 + 구간반복 + 이어보기 저장
  let lastSave = 0;
  v.addEventListener('timeupdate', () => {
    const { o, d, A, B } = ab();                 // A=loopA??0, B=loopB??길이 → 한쪽만 설정해도 동작
    if (o.loopOn && d && B > A + 0.05) {
      if (v.currentTime >= B - 0.03 || v.currentTime < A - 0.25) { try { v.currentTime = A; } catch {} }
    }
    playhead();
    if (o.resume && Date.now() - lastSave > 3000) { lastSave = Date.now(); o.pos = v.currentTime; setOpt(item.key, o); }
  });

  tile.appendChild(v);
  tile.appendChild(bar);
  layoutSeek();
  tile.addEventListener('click', () => toggleAudio(idx));      // 영상 클릭 = 소리 토글(켜기/끄기)
  tile.addEventListener('dblclick', () => v.requestFullscreen?.());
  return tile;
}

// 소리 토글 — 이미 켜진 칸을 다시 누르면 끔(전체 음소거). 아니면 그 칸만 켜고 나머지 음소거(solo).
function toggleAudio(idx) {
  const tiles = grid.querySelectorAll('.tile');
  const cur = tiles[idx] && tiles[idx].querySelector('video');
  const turnOff = cur && !cur.muted;      // 이미 소리 켜져 있으면 이번 클릭은 '끄기'
  tiles.forEach((t, i) => {
    const v = t.querySelector('video'); if (!v) return;
    const on = !turnOff && i === idx;
    v.muted = !on;
    if (on) { if (!(v.volume > 0)) v.volume = 1; v.play().catch(() => {}); }  // 켤 때 볼륨 보장 + 재생 (안 들리는 문제 방지)
    t.classList.toggle('audio-on', on);
    const mb = t.querySelector('.mute'); if (mb) mb.textContent = on ? '🔊' : '🔇';
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

// ── 칸별 개별 파일 추가(빈 칸 ＋ 버튼) ────────────────
let cellAddTargetIdx = -1;
async function addFileToCell(idx) {
  if (window.showOpenFilePicker) {
    let handles;
    try {
      handles = await window.showOpenFilePicker({ multiple: true, types: PICKER_TYPES });
    } catch (err) {
      if (err && err.name === 'AbortError') return;     // 사용자가 취소
      setHint('파일 열기 실패: ' + (err && err.message || err));   // 그 외 오류는 노출(조용히 죽지 않게)
      return;
    }
    if (!handles || !handles.length) return;
    const items = await itemsFromStored(handles);
    assignItemsToCell(idx, items);
    // 현재 불러온 모든 FSA 파일핸들을 보존 → 재실행 시 동일 세트 복원
    const all = videos.map(v => v._handle).filter(Boolean);
    if (all.length) { currentSource = 'fsa'; setActiveSlot(null); await saveHandle(all); }
  } else {
    cellAddTargetIdx = idx;                   // input 폴백(사파리/모바일 일부)
    document.getElementById('cellFilePick').click();
  }
}
// 추가한 영상을 목록에 합치고 첫 항목은 이 칸, 나머지는 이후 빈 칸에 채움
function assignItemsToCell(idx, items) {
  if (!items || !items.length) return;
  for (const it of items) { if (!videos.some(v => v.key === it.key)) videos.push(it); }
  cells[idx] = items[0];
  let j = 1;
  for (let c = 0; c < cells.length && j < items.length; c++) { if (!cells[c]) cells[c] = items[j++]; }
  setHint(`${items.length}개 추가됨`);
  saveSession(); render();
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
      const byKey = Object.fromEntries(videos.map(v => [normKey(v.key), v]));
      cells = s.cellKeys.slice(0, LAYOUT_CELLS[layout]).map(k => byKey[normKey(k)] || null);
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
    if (items) { currentSource = 'fsa'; setActiveSlot(null); restoreFromSettingsThenLoad(items); } else setHint('');
  } else {                                            // 그 외: webkitdirectory 폴더 input(데스크톱) — 모바일은 "파일 선택" 권장
    document.getElementById('dirPick').click();
  }
};
document.getElementById('btnFiles').onclick = async () => {
  if (window.showOpenFilePicker) {                  // 핸들 기반 → 슬롯 저장 시 재선택 없이 복원
    setHint('파일 선택…'); const items = await pickFiles();
    if (items) { currentSource = 'fsa'; setActiveSlot(null); restoreFromSettingsThenLoad(items); } else setHint('');
  } else {                                            // 미지원(사파리/모바일 일부): input 폴백(복원 시 재선택 필요)
    document.getElementById('filePick').click();
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
// 현재 화면 콘텐츠가 어느 슬롯에서 왔는지(없으면 임의 폴더/파일) — 재실행 시 잠금 판단용
const ACTIVE_SLOT_KEY = 'vg:activeSlot';
function getActiveSlot() { return localStorage.getItem(ACTIVE_SLOT_KEY) || null; }
function setActiveSlot(s) { if (s) localStorage.setItem(ACTIVE_SLOT_KEY, s); else localStorage.removeItem(ACTIVE_SLOT_KEY); }
// 복원 콘텐츠가 비번 걸린 슬롯의 것이면 그 슬롯을 반환(없으면 null). 여러 신호로 견고하게 판별.
async function lockSlotForRestore(stored, sess) {
  const normArr = (arr) => JSON.stringify((arr || []).map(k => (k ? normKey(k) : null)));
  const sessKeys = normArr(sess && sess.cellKeys);
  // 1) activeSlot
  const a = getActiveSlot();
  if (a && slotPw(a)) return a;
  // 2) 세션 내용(cellKeys)이 비번 슬롯 저장본과 일치
  if (sessKeys !== '[]') {
    for (const s of SLOTS) {
      if (!slotPw(s)) continue;
      const meta = slotMeta(s);
      if (meta && normArr(meta.cellKeys) === sessKeys) return s;
    }
  }
  // 3) 저장 핸들이 비번 슬롯 핸들과 동일
  for (const s of SLOTS) {
    if (!slotPw(s)) continue;
    try { if (await sameHandle(await loadHandle('dir:' + s), stored)) return s; } catch {}
  }
  return null;
}

// ── 비번 잠금화면(전체 가림) ──────────────────────────
let lockTargetSlot = null, pendingUnlock = null, lockPushed = false;
function lockApp(slot, onUnlock) {
  lockTargetSlot = slot; pendingUnlock = onUnlock || null;
  document.getElementById('lockName').textContent = slot;
  document.getElementById('lockMsg').textContent = '';
  const inp = document.getElementById('lockInput'); inp.value = '';
  document.body.classList.add('locked');
  document.getElementById('lockScreen').classList.remove('hidden');
  // 뒤로가기가 앱을 종료시키지 않도록 히스토리 항목 하나 추가 → 뒤로가기 시 잠금만 닫힘
  if (!lockPushed) { try { history.pushState({ vgLock: 1 }, ''); lockPushed = true; } catch {} }
  setTimeout(() => inp.focus(), 50);
}
// 잠금화면만 닫고 앱 화면으로 (복원 콜백 실행 안 함)
function closeLock() {
  pendingUnlock = null; lockTargetSlot = null;
  document.body.classList.remove('locked');
  document.getElementById('lockScreen').classList.add('hidden');
}
// 취소/뒤로 버튼 — 쌓아둔 히스토리 정리 후 닫기
function cancelLock() {
  const wasPushed = lockPushed; lockPushed = false;
  closeLock();
  if (wasPushed) { try { history.back(); } catch {} }
}
function unlockApp() {
  document.body.classList.remove('locked');
  document.getElementById('lockScreen').classList.add('hidden');
  lockTargetSlot = null;
  if (lockPushed) { lockPushed = false; try { history.back(); } catch {} } // 쌓아둔 히스토리 정리
}
// 하드웨어/브라우저 뒤로가기: 잠금 중이면 앱 종료 대신 잠금만 닫기
window.addEventListener('popstate', () => {
  if (document.body.classList.contains('locked')) { lockPushed = false; closeLock(); }
});
async function tryUnlock() {
  const slot = lockTargetSlot; if (!slot) return;
  const inp = document.getElementById('lockInput'), pw = slotPw(slot);
  if (pw && (await pwHash(inp.value)) !== pw) {
    document.getElementById('lockMsg').textContent = '비밀번호가 틀렸습니다.';
    inp.select(); return;
  }
  const cb = pendingUnlock; pendingUnlock = null;
  unlockApp();
  if (cb) { try { await cb(); } catch {} }
}
function updateSlotUI() {
  document.querySelectorAll('.slot').forEach(btn => {
    const s = btn.dataset.slot, meta = slotMeta(s), locked = !!slotPw(s);
    btn.classList.toggle('has', !!meta);
    btn.classList.toggle('locked', locked);
    btn.textContent = (locked ? '🔒' : '') + s;
    btn.title = meta ? `슬롯 ${s} · ${meta.count || 0}개${locked ? ' · 비번잠금' : ''} (누르기=불러오기 · 길게=관리)`
                     : `슬롯 ${s} 비어있음 (누르기=현재 상태 저장 · 길게=관리)`;
    const x = document.querySelector(`.slot-x[data-slotx="${s}"]`);
    if (x) x.hidden = !meta && !locked;        // 저장본/비번 있을 때만 해제(✕) 노출
  });
}
async function saveSlot(s) {
  if (!videos.length) { setHint('먼저 폴더/파일을 불러온 뒤 저장하세요'); return; }
  saveSession();                                                  // 현재 상태를 vg:session에 스냅샷
  localStorage.setItem('vg:slot:' + s, localStorage.getItem('vg:session') || '{}');
  if (currentSource === 'fsa') await copyHandle('dir', 'dir:' + s); else await deleteHandle('dir:' + s);
  setActiveSlot(s);                                               // 현재 콘텐츠 = 이 슬롯
  updateSlotUI(); setHint(`슬롯 ${s}에 저장됨${slotPw(s) ? ' (비번잠금)' : ''}`);
}
async function loadSlot(s) {
  const meta = slotMeta(s);
  if (!meta) { setHint(`슬롯 ${s}는 비어있습니다`); return; }
  const proceed = async () => {
    localStorage.setItem('vg:session', JSON.stringify(meta));     // 이 슬롯을 현재 세션으로
    await copyHandle('dir:' + s, 'dir');
    setActiveSlot(s);
    await restoreSession(false);                                 // 이미 잠금 통과 → 재잠금 안 함
  };
  if (slotPw(s)) lockApp(s, proceed);                            // 비번 슬롯 → 잠금화면 통과 후 로드
  else await proceed();
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
  deleteHandle('dir:' + s);
  if (getActiveSlot() === s) setActiveSlot(null);
  updateSlotUI(); setHint(`슬롯 ${s} 해제됨`);
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
// 슬롯 ✕ = 해제(삭제). 슬롯 버튼 동작/롱프레스와 분리.
document.querySelectorAll('.slot-x').forEach(x => {
  x.addEventListener('pointerdown', e => { e.stopPropagation(); });
  x.addEventListener('click', e => { e.stopPropagation(); e.preventDefault(); deleteSlot(x.dataset.slotx); });
});
// 잠금화면 해제
document.getElementById('lockUnlock').onclick = tryUnlock;
document.getElementById('lockCancel')?.addEventListener('click', cancelLock);
document.getElementById('lockInput').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); } });
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
document.getElementById('dirPick').onchange = (e) => { const items = toItems([...e.target.files]); if (items.length) { currentSource = 'input'; setActiveSlot(null); restoreFromSettingsThenLoad(items); } e.target.value = ''; };
document.getElementById('filePick').onchange = (e) => { const items = toItems([...e.target.files]); if (items.length) { currentSource = 'input'; setActiveSlot(null); restoreFromSettingsThenLoad(items); } e.target.value = ''; };
document.getElementById('cellFilePick').onchange = (e) => { const items = toItems([...e.target.files]); if (items.length && cellAddTargetIdx >= 0) { if (currentSource !== 'fsa') currentSource = 'input'; assignItemsToCell(cellAddTargetIdx, items); } cellAddTargetIdx = -1; e.target.value = ''; };
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
async function restoreSession(gatePw = true) {
  const sess = loadSessionRaw();
  if (sess.layout && LAYOUT_CELLS[sess.layout]) { layout = sess.layout; setLayoutUI(); cells = Array.from({ length: LAYOUT_CELLS[layout] }, () => null); render(); }
  let stored = null; try { stored = await loadHandle(); } catch {}
  if (stored) {
    const isDir = !Array.isArray(stored) && stored.kind === 'directory';
    // 복원 대상이 비번 걸린 슬롯의 콘텐츠면 잠금 (activeSlot·세션내용·핸들 3중 판별)
    const lockSlot = gatePw ? await lockSlotForRestore(stored, sess) : null;
    const needPw = !!lockSlot;                                  // loadSlot 은 gatePw=false → 재잠금 안 함

    // 실제 복원 (권한 없으면 요청)
    const doRestore = async () => {
      let perm = 'prompt'; try { perm = await permState(stored); } catch {}
      if (perm !== 'granted' && !(await requestPermFor(stored))) { setHint('접근 권한 거부됨'); return; }
      const items = await itemsFromStored(stored);
      if (items && items.length) { currentSource = 'fsa'; setHint(isDir ? '이전 폴더 복원됨' : '이전 파일 복원됨'); restoreFromSettingsThenLoad(items); }
    };

    if (needPw) {                                              // 비번 슬롯 → 자동복원 금지, '다시 열기' 누르면 잠금화면 먼저
      showRestoreBanner(`${isDir ? '🔒 이전 폴더 다시 열기' : '🔒 이전 파일 다시 열기'}${sess.count ? ` · ${sess.count}개` : ''} · 비번`, () => lockApp(lockSlot, doRestore));
      return;
    }

    let perm = 'prompt'; try { perm = await permState(stored); } catch {}
    if (perm === 'granted') {                                   // 비번 없음 + 권한 유지 → 재선택 없이 자동 복원
      try {
        const items = await itemsFromStored(stored);
        if (items && items.length) { currentSource = 'fsa'; setHint(isDir ? '이전 폴더 복원됨' : '이전 파일 복원됨'); restoreFromSettingsThenLoad(items); return; }
      } catch {}
    }
    showRestoreBanner(`${isDir ? '📂 이전 폴더 다시 열기' : '📄 이전 파일 다시 열기'}${sess.count ? ` · ${sess.count}개` : ''}`, doRestore);
    return;
  }
  if (Array.isArray(sess.cellKeys) && sess.cellKeys.some(Boolean)) {     // input 폴백 세션 → 재선택 필요
    showRestoreBanner('📄 이전 파일 다시 선택 (같은 칸 자동 복원)', () => document.getElementById('filePick').click());
  } else {
    setHint('저장된 세션이 없습니다 — 폴더/파일을 불러오세요');
  }
}

// 시작 시 자동복원 — 단, 마지막 콘텐츠가 비번 걸린 슬롯이면 잠금화면 통과 후 복원.
// (비번 없는 콘텐츠는 기존처럼 권한 있으면 자동, 없으면 '다시 열기' 배너.)
async function bootRestore() {
  await restoreSession();
}

// 초기 실행
(async () => {
  if (!window.showDirectoryPicker) document.getElementById('btnFolder').title = '폴더 기억 미지원 — "파일 선택" 사용';
  cells = Array.from({ length: LAYOUT_CELLS[layout] }, () => null);
  render();
  updateSlotUI();
  const filled = SLOTS.filter(s => slotMeta(s));
  setHint(filled.length ? `슬롯 ${filled.join('/')} 저장됨 — 눌러서 불러오기` : '폴더/파일을 불러온 뒤 A·B·C에 저장하세요');
  await bootRestore();
})();
