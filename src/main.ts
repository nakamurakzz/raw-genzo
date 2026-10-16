// 数字と LUT 名用の書体は自前で配信（外部へのリクエストを出さない）
import '@fontsource/barlow-semi-condensed/latin-500.css';
import '@fontsource/barlow-semi-condensed/latin-600.css';
import './style.css';
import { INPUTS, lumaRec709, srgbDecode, type InputSpace } from './color.ts';
import { decodeRaw } from './raw.ts';
import type { LensParams } from './lens.ts';
import { findVignetting, type VignettingResult } from './lensfun.ts';
import type { LensMeta } from './rw2meta.ts';
import { NEUTRAL, deleteEntry, fetchAbpy, importFiles, loadSaved, saveEntries, sortEntries, type LutEntry } from './luts.ts';
import type { WorkerRequest, WorkerResponse } from './render.worker.ts';
import { drawSwatch } from './swatch.ts';

// ---------- DOM ----------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const rawInput = $<HTMLInputElement>('rawInput');
const lutInput = $<HTMLInputElement>('lutInput');
const fileInfo = $<HTMLDivElement>('fileInfo');
const frame = $<HTMLDivElement>('frame');
const canvas = $<HTMLCanvasElement>('preview');
const empty = $<HTMLDivElement>('empty');
const busy = $<HTMLDivElement>('busy');
const busyText = $<HTMLSpanElement>('busyText');
const stageHint = $<HTMLParagraphElement>('stageHint');
const evInput = $<HTMLInputElement>('ev');
const evOut = $<HTMLOutputElement>('evOut');
const evReset = $<HTMLButtonElement>('evReset');
const evTicks = $<HTMLDivElement>('evTicks');
const listBase = $<HTMLDivElement>('listBase');
const listAbpy = $<HTMLDivElement>('listAbpy');
const listUser = $<HTMLDivElement>('listUser');
const abpyEmpty = $<HTMLDivElement>('abpyEmpty');
const abpyLoad = $<HTMLButtonElement>('abpyLoad');
const abpyCredit = $<HTMLParagraphElement>('abpyCredit');
const exportBtn = $<HTMLButtonElement>('exportBtn');
const exportStatus = $<HTMLParagraphElement>('exportStatus');
const toast = $<HTMLParagraphElement>('toast');
const lensGroup = $<HTMLElement>('lensGroup');
const lensName = $<HTMLParagraphElement>('lensName');
const lensDist = $<HTMLInputElement>('lensDist');
const lensVig = $<HTMLInputElement>('lensVig');
const lensDistNote = $<HTMLSpanElement>('lensDistNote');
const lensVigNote = $<HTMLSpanElement>('lensVigNote');
const lensfunCredit = $<HTMLParagraphElement>('lensfunCredit');

// ---------- 状態 ----------
type View = 'lut' | 'flat' | 'jpeg';
interface LoadedImage {
  name: string;
  width: number;
  height: number;
  pw: number;
  ph: number;
  flip: number;
  thumb: ImageBitmap | null;
}

let entries: LutEntry[] = [NEUTRAL];
let selectedKey = readPref('selected') ?? NEUTRAL.key;
let view: View = 'lut';
let holdFlat = false;
let comp = 0; // 露出補正（1/3 段刻み）
let autoEV = 0; // カメラ JPEG と中央値の明るさを合わせる基準露出
let image: LoadedImage | null = null;

type VigStatus = 'loading' | 'ok' | 'none' | 'shading' | 'nodata' | 'error';
interface LensState { meta: LensMeta; vig: VignettingResult | null; vigStatus: VigStatus }
let lensState: LensState | null = null;
let lensToken = 0;

function readPref(k: string): string | null {
  try { return localStorage.getItem(`raw-lut-lab:${k}`); } catch { return null; }
}
function writePref(k: string, v: string) {
  try { localStorage.setItem(`raw-lut-lab:${k}`, v); } catch { /* noop */ }
}

const selected = () => entries.find((e) => e.key === selectedKey) ?? NEUTRAL;

// ---------- Worker ----------
type DistOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type Ok<K extends string> = Extract<WorkerResponse, { ok: true; kind: K }>;

const worker = new Worker(new URL('./render.worker.ts', import.meta.url), { type: 'module' });
let seq = 0;
const pending = new Map<number, { resolve: (r: WorkerResponse) => void }>();
worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
  const p = pending.get(e.data.id);
  pending.delete(e.data.id);
  p?.resolve(e.data);
};

function call<R extends DistOmit<WorkerRequest, 'id'>>(
  req: R,
  transfer: Transferable[] = [],
): Promise<Ok<R['kind']>> {
  const id = ++seq;
  return new Promise((resolve, reject) => {
    pending.set(id, {
      resolve: (r) => (r.ok ? resolve(r as Ok<R['kind']>) : reject(new Error(r.error))),
    });
    worker.postMessage({ ...req, id }, transfer);
  });
}

const sentLuts = new Set<string>();
async function ensureLut(e: LutEntry) {
  if (sentLuts.has(e.key)) return;
  await call({ kind: 'lut', key: e.key, lut: e.lut });
  sentLuts.add(e.key);
}

// ---------- 表示 ----------
function showError(msg: string) {
  toast.textContent = msg;
  toast.hidden = false;
  clearTimeout((showError as { t?: number }).t);
  (showError as { t?: number }).t = window.setTimeout(() => (toast.hidden = true), 7000);
}

function setBusy(text: string | null) {
  busy.hidden = text === null;
  if (text) busyText.textContent = text;
}

function fmtEV(v: number) {
  const r = Math.round(v * 10) / 10;
  if (r === 0) return '0.0';
  return (r > 0 ? '+' : '−') + Math.abs(r).toFixed(1);
}

let rendering = false;
let dirty = false;
async function requestRender() {
  if (!image) return;
  if (rendering) { dirty = true; return; }
  rendering = true;
  try {
    do {
      dirty = false;
      await renderOnce();
    } while (dirty);
  } catch (e) {
    showError(`表示に失敗しました: ${e instanceof Error ? e.message : e}`);
  } finally {
    rendering = false;
  }
}

async function renderOnce() {
  if (!image) return;
  const v: View = holdFlat ? 'flat' : view;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  if (v === 'jpeg') {
    if (!image.thumb) {
      ctx.fillStyle = '#333';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      return;
    }
    drawThumb(ctx, image.thumb, image);
    return;
  }
  const e = v === 'flat' ? NEUTRAL : selected();
  await ensureLut(e);
  const r = await call({ kind: 'preview', key: e.key, input: e.input, output: e.output, ev: autoEV + comp });
  canvas.width = r.pw;
  canvas.height = r.ph;
  ctx.putImageData(new ImageData(r.rgba as Uint8ClampedArray<ArrayBuffer>, r.pw, r.ph), 0, 0);
}

/** 埋め込み JPEG は RAW と向きが違うことがあるので、縦横が食い違ったら flip に従って回す */
function drawThumb(ctx: CanvasRenderingContext2D, bmp: ImageBitmap, img: LoadedImage) {
  canvas.width = img.pw;
  canvas.height = img.ph;
  const rawPortrait = img.ph > img.pw;
  const thumbPortrait = bmp.height > bmp.width;
  ctx.save();
  if (rawPortrait !== thumbPortrait) {
    ctx.translate(img.pw / 2, img.ph / 2);
    ctx.rotate(img.flip === 5 ? -Math.PI / 2 : Math.PI / 2);
    ctx.drawImage(bmp, -img.ph / 2, -img.pw / 2, img.ph, img.pw);
  } else {
    ctx.drawImage(bmp, 0, 0, img.pw, img.ph);
  }
  ctx.restore();
}

async function medianOfJpeg(bmp: ImageBitmap): Promise<number> {
  const w = 256;
  const h = Math.max(1, Math.round((bmp.height / bmp.width) * w));
  const c = new OffscreenCanvas(w, h);
  const ctx = c.getContext('2d');
  if (!ctx) return NaN;
  ctx.drawImage(bmp, 0, 0, w, h);
  const d = ctx.getImageData(0, 0, w, h).data;
  const lut = new Float32Array(256);
  for (let i = 0; i < 256; i++) lut[i] = srgbDecode(i / 255);
  const ys = new Float32Array(w * h);
  for (let i = 0, j = 0; i < d.length; i += 4, j++) ys[j] = lumaRec709(lut[d[i]], lut[d[i + 1]], lut[d[i + 2]]);
  ys.sort();
  return ys[ys.length >> 1];
}

// ---------- RAW を開く ----------
async function openRaw(file: File) {
  setBusy('RAW を展開しています');
  empty.hidden = true;
  exportBtn.disabled = true;
  exportStatus.textContent = '';
  try {
    const raw = await decodeRaw(file);
    setBusy('プレビューを準備しています');
    const thumb = raw.thumb ? await createImageBitmap(raw.thumb).catch(() => null) : null;
    const previewMax = Math.max(1200, Math.min(2048, Math.round(Math.max(innerWidth, innerHeight) * Math.min(2, devicePixelRatio || 1) * 0.75)));
    const { width, height, flip } = raw;
    const loaded = await call({ kind: 'load', data: raw.data, width, height, previewMax }, [raw.data.buffer]);
    image?.thumb?.close();
    image = { name: file.name, width, height, pw: loaded.pw, ph: loaded.ph, flip, thumb };

    const camMedian = thumb ? await medianOfJpeg(thumb) : NaN;
    const ratio = camMedian / loaded.median;
    autoEV = Number.isFinite(ratio) && ratio > 0 ? Math.max(-5, Math.min(5, Math.log2(ratio))) : Math.log2(0.12 / Math.max(1e-4, loaded.median));

    await setupLens(raw.lens);

    renderFileInfo(file.name, raw.camera, raw.exposure, raw.ms);
    canvas.hidden = false;
    stageHint.hidden = false;
    document.querySelector('.app')?.classList.add('has-image');
    evInput.disabled = false;
    exportBtn.disabled = false;
    updateExportLabel();
    await requestRender();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    showError(`${file.name} を RAW として読めませんでした（${msg}）`);
    if (!image) empty.hidden = false;
  } finally {
    setBusy(null);
  }
}

function renderFileInfo(name: string, camera: string, exposure: string[], ms: number) {
  fileInfo.replaceChildren();
  const n = document.createElement('span');
  n.className = 'file-name';
  n.textContent = name;
  const m = document.createElement('span');
  m.className = 'file-meta';
  for (const part of [camera, ...exposure].filter(Boolean)) {
    const s = document.createElement('span');
    s.textContent = part;
    m.append(s);
  }
  const t = document.createElement('span');
  t.className = 'file-time';
  t.textContent = `展開 ${(ms / 1000).toFixed(1)}秒`;
  fileInfo.append(n, m, t);
}

// ---------- レンズ補正 ----------
lensDist.checked = readPref('lens.dist') !== '0';
lensVig.checked = readPref('lens.vig') !== '0';

const VIG_NOTE: Record<VigStatus, string> = {
  loading: 'Lensfun を読み込んでいます…',
  ok: '',
  none: 'Lensfun にこのレンズのデータがありません',
  shading: 'カメラ側で補正済み（シェーディング補正 On）',
  nodata: 'レンズ・焦点距離・F 値の情報がありません',
  error: 'Lensfun を取得できませんでした',
};

function renderLensUI() {
  lensGroup.hidden = !lensState;
  if (!lensState) return;
  const { meta, vig, vigStatus } = lensState;
  lensName.textContent = meta.lensName ?? 'レンズ不明';
  lensDist.disabled = !meta.distortion;
  lensDistNote.textContent = meta.distortion ? 'RAW に記録された補正データ' : 'このファイルには補正データがありません';
  lensVig.disabled = vigStatus !== 'ok';
  lensVigNote.textContent =
    vigStatus === 'ok' && vig ? `Lensfun「${vig.lensModel}」F${+(meta.aperture ?? 0).toFixed(1)}` : VIG_NOTE[vigStatus];
  lensfunCredit.hidden = vigStatus !== 'ok';
}

function currentLensParams(): LensParams | null {
  if (!lensState) return null;
  const { meta, vig } = lensState;
  return {
    distortion: lensDist.checked && meta.distortion ? meta.distortion : null,
    vignetting: lensVig.checked && vig ? { k: vig.k, rScale: vig.rScale } : null,
  };
}

async function pushLens() {
  await call({ kind: 'lens', params: currentLensParams() });
}

/** 歪曲はすぐ適用し、周辺減光は Lensfun を取得できたら追って適用する */
async function setupLens(meta: LensMeta) {
  const token = ++lensToken;
  const vigStatus: VigStatus =
    meta.shadingCompensation ? 'shading' : !meta.lensName || !meta.focal || !meta.aperture ? 'nodata' : 'loading';
  lensState = { meta, vig: null, vigStatus };
  renderLensUI();
  await pushLens();
  if (vigStatus !== 'loading') return;
  void (async () => {
    let vig: VignettingResult | null = null;
    let status: VigStatus;
    try {
      vig = await findVignetting(meta.lensName!, meta.focal!, meta.aperture!);
      status = vig ? 'ok' : 'none';
    } catch {
      status = 'error';
    }
    if (token !== lensToken || !lensState) return; // 別の RAW を開いた
    lensState = { ...lensState, vig, vigStatus: status };
    renderLensUI();
    if (vig && lensVig.checked) {
      await pushLens();
      void requestRender();
    }
  })();
}

for (const [box, key] of [[lensDist, 'lens.dist'], [lensVig, 'lens.vig']] as const) {
  box.addEventListener('change', async () => {
    writePref(key, box.checked ? '1' : '0');
    await pushLens();
    void requestRender();
  });
}

// ---------- LUT 一覧 ----------
const INPUT_ORDER: InputSpace[] = ['flog2', 'flog2c', 'flog', 'srgb', 'p3'];
const SHORT_TAG: Record<InputSpace, string> = {
  flog2: 'F-Log2', flog2c: 'F-Log2 C', flog: 'F-Log', srgb: 'sRGB', p3: 'P3', scene: 'sRGB',
};

function renderLists() {
  const groups: Array<[HTMLDivElement, LutEntry[]]> = [
    [listBase, entries.filter((e) => e.group === 'base')],
    [listAbpy, entries.filter((e) => e.group === 'abpy')],
    [listUser, entries.filter((e) => e.group === 'user')],
  ];
  for (const [el, list] of groups) {
    el.replaceChildren(...list.map(renderItem));
  }
  const hasAbpy = entries.some((e) => e.group === 'abpy');
  abpyEmpty.hidden = hasAbpy;
  abpyCredit.hidden = !hasAbpy;
  requestAnimationFrame(() => {
    for (const c of document.querySelectorAll<HTMLCanvasElement>('canvas.item-swatch')) {
      const e = entries.find((x) => x.key === c.dataset.key);
      if (e) drawSwatch(c, e);
    }
  });
}

function renderItem(e: LutEntry): HTMLElement {
  const item = document.createElement('div');
  item.className = 'item';
  item.setAttribute('aria-current', String(e.key === selectedKey));

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'item-main';
  btn.setAttribute('role', 'radio');
  btn.setAttribute('aria-checked', String(e.key === selectedKey));
  btn.title = e.file ?? e.name;
  const name = document.createElement('span');
  name.className = 'item-name';
  name.textContent = e.name;
  const tag = document.createElement('span');
  tag.className = 'item-tag';
  tag.textContent = e.group === 'base' ? 'LUTなし' : SHORT_TAG[e.input];
  const sw = document.createElement('canvas');
  sw.className = 'item-swatch';
  sw.dataset.key = e.key;
  sw.setAttribute('aria-hidden', 'true');
  btn.append(name, tag, sw);
  btn.addEventListener('click', () => select(e.key));
  item.append(btn);

  if (e.group === 'user') {
    const tools = document.createElement('div');
    tools.className = 'item-tools';
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', `${e.name} の入力`);
    for (const k of INPUT_ORDER) {
      const o = document.createElement('option');
      o.value = k;
      o.textContent = `入力: ${INPUTS[k].label}`;
      o.selected = k === e.input;
      sel.append(o);
    }
    sel.addEventListener('change', () => {
      e.input = sel.value as InputSpace;
      e.output = e.input === 'p3' ? 'p3' : 'srgb';
      void saveEntries([e]);
      renderLists();
      if (e.key === selectedKey) void requestRender();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'link';
    del.textContent = '削除';
    del.setAttribute('aria-label', `${e.name} を削除`);
    del.addEventListener('click', () => removeEntry(e.key));
    tools.append(sel, del);
    item.append(tools);
  }
  return item;
}

function select(key: string) {
  selectedKey = key;
  writePref('selected', key);
  for (const item of document.querySelectorAll<HTMLElement>('.item')) {
    const k = item.querySelector<HTMLCanvasElement>('canvas')?.dataset.key;
    item.setAttribute('aria-current', String(k === key));
    item.querySelector('.item-main')?.setAttribute('aria-checked', String(k === key));
  }
  updateExportLabel();
  if (view === 'jpeg') setView('lut');
  void requestRender();
}

function addEntries(list: LutEntry[]) {
  const map = new Map(entries.map((e) => [e.key, e]));
  for (const e of list) {
    map.set(e.key, e);
    sentLuts.delete(e.key);
  }
  entries = sortEntries([...map.values()]);
  renderLists();
}

function removeEntry(key: string) {
  entries = entries.filter((e) => e.key !== key);
  void deleteEntry(key);
  if (selectedKey === key) select(NEUTRAL.key);
  renderLists();
}

async function importLuts(files: File[]) {
  const { entries: added, errors } = await importFiles(files);
  if (added.length) {
    addEntries(added);
    void saveEntries(added);
    select(added[0].key);
  }
  if (errors.length) showError(`読み込めなかった LUT があります: ${errors.slice(0, 3).join(' / ')}${errors.length > 3 ? ` ほか ${errors.length - 3} 件` : ''}`);
}

abpyLoad.addEventListener('click', async () => {
  abpyLoad.disabled = true;
  try {
    const list = await fetchAbpy((d, t) => (abpyLoad.textContent = `読み込み中 ${d} / ${t}`));
    addEntries(list);
    void saveEntries(list);
    select(list[0].key);
  } catch (e) {
    showError(`GitHub から LUT を取得できませんでした（${e instanceof Error ? e.message : e}）`);
  } finally {
    abpyLoad.disabled = false;
    abpyLoad.textContent = 'abpy の LUT を読み込む';
  }
});

// ---------- 表示切替・露出 ----------
function setView(v: View) {
  view = v;
  const r = document.querySelector<HTMLInputElement>(`input[name="view"][value="${v}"]`);
  if (r) r.checked = true;
  void requestRender();
}
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="view"]')) {
  r.addEventListener('change', () => setView(r.value as View));
}

function buildTicks() {
  const frag = document.createDocumentFragment();
  for (let i = -9; i <= 9; i++) {
    const pos = `${((i + 9) / 18) * 100}%`;
    const t = document.createElement('i');
    t.style.left = pos;
    if (i % 3 === 0) t.className = i === 0 ? 'major zero' : 'major';
    frag.append(t);
    if (i % 3 === 0) {
      const b = document.createElement('b');
      b.style.left = pos;
      b.textContent = i === 0 ? '0' : `${i > 0 ? '+' : '−'}${Math.abs(i / 3)}`;
      frag.append(b);
    }
  }
  evTicks.replaceChildren(frag);
}

function setComp(v: number) {
  comp = Math.round(v * 3) / 3;
  evInput.value = String(comp);
  evOut.textContent = fmtEV(comp);
  void requestRender();
}
evInput.addEventListener('input', () => setComp(+evInput.value));
evReset.addEventListener('click', () => setComp(0));
evInput.addEventListener('dblclick', () => setComp(0));

// 長押しでニュートラルと比較（スクロールの始まりで切り替わらないよう少し待つ）
let holdTimer = 0;
canvas.addEventListener('pointerdown', () => {
  if (view === 'jpeg') return;
  clearTimeout(holdTimer);
  holdTimer = window.setTimeout(() => {
    holdFlat = true;
    void requestRender();
  }, 160);
});
const release = () => {
  clearTimeout(holdTimer);
  if (!holdFlat) return;
  holdFlat = false;
  void requestRender();
};
canvas.addEventListener('pointerleave', release);
canvas.addEventListener('pointerup', release);
canvas.addEventListener('pointercancel', release);
canvas.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- 書き出し ----------
function updateExportLabel() {
  exportBtn.textContent = `「${selected().name}」で JPEG を書き出す`;
}

exportBtn.addEventListener('click', async () => {
  if (!image) return;
  const e = selected();
  exportBtn.disabled = true;
  exportStatus.textContent = `${image.width}×${image.height} を書き出しています…`;
  try {
    await ensureLut(e);
    const r = await call({ kind: 'export', key: e.key, input: e.input, output: e.output, ev: autoEV + comp, quality: 0.92 });
    const base = image.name.replace(/\.[^.]+$/, '');
    const slug = e.name.replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '').toLowerCase();
    const url = URL.createObjectURL(r.blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${base}_${slug}.jpg`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    exportStatus.textContent = `${a.download} を保存しました（${(r.blob.size / 1e6).toFixed(1)}MB、${(r.ms / 1000).toFixed(1)}秒）`;
  } catch (err) {
    exportStatus.textContent = '';
    showError(`書き出しに失敗しました（${err instanceof Error ? err.message : err}）`);
  } finally {
    exportBtn.disabled = false;
  }
});

// ---------- ファイル入力・ドロップ ----------
const isLutFile = (f: File) => /\.(cube|zip)$/i.test(f.name);

rawInput.addEventListener('change', () => {
  const f = rawInput.files?.[0];
  rawInput.value = '';
  if (f) void (isLutFile(f) ? importLuts([f]) : openRaw(f));
});
lutInput.addEventListener('change', () => {
  const fs = [...(lutInput.files ?? [])];
  lutInput.value = '';
  if (fs.length) void importLuts(fs);
});

let dragDepth = 0;
window.addEventListener('dragenter', (e) => {
  if (!e.dataTransfer?.types.includes('Files')) return;
  dragDepth++;
  frame.classList.add('drag');
});
window.addEventListener('dragleave', () => {
  if (--dragDepth <= 0) { dragDepth = 0; frame.classList.remove('drag'); }
});
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  frame.classList.remove('drag');
  const files = [...(e.dataTransfer?.files ?? [])];
  const luts = files.filter(isLutFile);
  const raws = files.filter((f) => !isLutFile(f));
  if (luts.length) void importLuts(luts);
  if (raws[0]) void openRaw(raws[0]);
});

// ---------- 起動 ----------
buildTicks();
evInput.disabled = true;
evOut.textContent = fmtEV(0);
renderLists();
updateExportLabel();
loadSaved().then((saved) => {
  if (saved.length) addEntries(saved);
  if (!entries.some((e) => e.key === selectedKey)) selectedKey = NEUTRAL.key;
  renderLists();
  updateExportLabel();
});

// テスト・デバッグ用の小さな窓口
Object.assign(window, { __lab: { openRaw, importLuts, select, setComp, setView, state: () => ({ autoEV, comp, selectedKey, image, lens: lensState, lensParams: currentLensParams() }) } });
