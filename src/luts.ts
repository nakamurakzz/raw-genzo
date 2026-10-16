// LUT の一覧管理：内蔵ニュートラル / abpy（GitHub から取得）/ ユーザーが読み込んだもの

import { unzipSync } from 'fflate';
import type { InputSpace, OutputSpace } from './color.ts';
import { makeIdentityLut, parseCube, type Lut3D } from './cube.ts';

export type LutGroup = 'base' | 'abpy' | 'user';

export interface LutEntry {
  key: string;
  name: string;
  group: LutGroup;
  input: InputSpace;
  output: OutputSpace;
  lut: Lut3D;
  file?: string;
}

export const NEUTRAL: LutEntry = {
  key: 'base:neutral',
  name: 'ニュートラル',
  group: 'base',
  // シーンリニア → Rec.709 原色へ変換してクリップ → sRGB 符号化。それ以外は何もしない
  input: 'scene',
  output: 'srgb',
  lut: makeIdentityLut(),
};

// abpy/FujifilmCameraProfiles（CC BY-NC-SA 4.0）。再配布はせず、利用者の操作で GitHub から取得する。
const ABPY_COMMIT = 'b5a1f16abfb2759b337c83d69d9dc49470e7e518';
export const ABPY_REPO = 'https://github.com/abpy/FujifilmCameraProfiles';
export const ABPY_LOOKS: ReadonlyArray<[file: string, name: string]> = [
  ['provia', 'Provia'],
  ['velvia', 'Velvia'],
  ['astia', 'Astia'],
  ['classic chrome', 'Classic Chrome'],
  ['reala ace', 'Reala Ace'],
  ['pro neg std', 'Pro Neg. Std'],
  ['pro neg hi', 'Pro Neg. Hi'],
  ['eterna', 'Eterna'],
  ['classic neg', 'Classic Neg.'],
  ['nostalgic neg', 'Nostalgic Neg.'],
  ['bleach bypass', 'Bleach Bypass'],
];

export async function fetchAbpy(onProgress: (done: number, total: number) => void): Promise<LutEntry[]> {
  const out: LutEntry[] = [];
  let done = 0;
  await Promise.all(
    ABPY_LOOKS.map(async ([file, name]) => {
      const url = `https://raw.githubusercontent.com/abpy/FujifilmCameraProfiles/${ABPY_COMMIT}/cube%20lut/${encodeURIComponent(file)}_sRGB.cube`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`${name} の取得に失敗しました（HTTP ${res.status}）`);
      const lut = parseCube(await res.text());
      out.push({ key: `abpy:${file}`, name, group: 'abpy', input: 'srgb', output: 'srgb', lut, file: `${file}_sRGB.cube` });
      onProgress(++done, ABPY_LOOKS.length);
    }),
  );
  const order = ABPY_LOOKS.map(([f]) => `abpy:${f}`);
  return out.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
}

const GROUP_ORDER: LutGroup[] = ['base', 'abpy', 'user'];
export function sortEntries(list: LutEntry[]): LutEntry[] {
  const abpyOrder = ABPY_LOOKS.map(([f]) => `abpy:${f}`);
  return [...list].sort((a, b) => {
    const g = GROUP_ORDER.indexOf(a.group) - GROUP_ORDER.indexOf(b.group);
    if (g) return g;
    if (a.group === 'abpy') return abpyOrder.indexOf(a.key) - abpyOrder.indexOf(b.key);
    return a.name.localeCompare(b.name, 'ja');
  });
}

/** ファイル名から入力の解釈を推測する（あとから UI で変更できる） */
export function guessInput(fileName: string): InputSpace {
  const s = fileName.toLowerCase().replace(/[\s_\-.()]/g, '');
  if (/flog2c|log2c|fgamutc/.test(s)) return 'flog2c';
  if (/flog2|log2/.test(s)) return 'flog2';
  if (/flog/.test(s)) return 'flog';
  if (/displayp3|p3/.test(s)) return 'p3';
  if (/srgb|rec709|bt709/.test(s) && !/to(rec|bt)709/.test(s)) return 'srgb';
  return 'flog2';
}

function prettyName(path: string): string {
  const base = path.split('/').pop() ?? path;
  return base.replace(/\.cube$/i, '').replace(/_/g, ' ').trim();
}

export interface ImportResult { entries: LutEntry[]; errors: string[] }

function collectCubes(name: string, bytes: Uint8Array, into: Array<{ path: string; text: string }>, depth = 0) {
  if (/\.zip$/i.test(name)) {
    if (depth > 2) return;
    const files = unzipSync(bytes, {
      filter: (f) => !f.name.includes('__MACOSX') && /\.(cube|zip)$/i.test(f.name),
    });
    for (const [p, b] of Object.entries(files)) collectCubes(p, b, into, depth + 1);
  } else if (/\.cube$/i.test(name)) {
    into.push({ path: name, text: new TextDecoder().decode(bytes) });
  }
}

export async function importFiles(files: File[]): Promise<ImportResult> {
  const cubes: Array<{ path: string; text: string }> = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      collectCubes(f.name, new Uint8Array(await f.arrayBuffer()), cubes);
    } catch (e) {
      errors.push(`${f.name}: ${e instanceof Error ? e.message : e}`);
    }
  }
  const entries: LutEntry[] = [];
  for (const c of cubes) {
    try {
      const lut = parseCube(c.text);
      const input = guessInput(c.path);
      entries.push({
        key: `user:${c.path}`,
        name: prettyName(c.path),
        group: 'user',
        input,
        output: input === 'p3' ? 'p3' : 'srgb',
        lut,
        file: c.path,
      });
    } catch (e) {
      errors.push(`${prettyName(c.path)}: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!cubes.length && !errors.length) errors.push('.cube ファイルが見つかりませんでした');
  entries.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return { entries, errors };
}

// ---- IndexedDB への保存（このブラウザだけの便利機能。失敗しても動作には影響しない） ----
const DB = 'raw-lut-lab';
const STORE = 'luts';

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'key' });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function loadSaved(): Promise<LutEntry[]> {
  try {
    const db = await openDb();
    return await new Promise((resolve, reject) => {
      const req = db.transaction(STORE).objectStore(STORE).getAll();
      req.onsuccess = () => resolve(req.result as LutEntry[]);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return [];
  }
}

export async function saveEntries(entries: LutEntry[]): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    for (const e of entries) tx.objectStore(STORE).put(e);
    await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  } catch {
    /* 保存できなくても続行 */
  }
}

export async function deleteEntry(key: string): Promise<void> {
  try {
    const db = await openDb();
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    await new Promise<void>((res, rej) => { tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error); });
  } catch {
    /* noop */
  }
}
