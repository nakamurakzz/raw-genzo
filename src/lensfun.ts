// Lensfun データベース（CC BY-SA 3.0）から周辺減光（pa モデル）の係数を求める。
// DB は利用時に GitHub から取得する（コミット固定）。XML は単純な構造なので正規表現で読む
// （Worker や Node のテストでも動くように DOMParser に依存しない）。
//
// pa モデル: 補正後 = 元 / (1 + k1·r² + k2·r⁴ + k3·r⁶)
// r はキャリブレーションに使ったセンサーの対角線の半分を 1 とする半径。
// 撮影画像とクロップ係数が違うときは r を cropCalib / cropImage 倍する（Lensfun の rescale と同じ）。

export const LENSFUN_COMMIT = '43f9e001ab66c4fcdd4f400463f13b72f94b2288';
export const LENSFUN_REPO = 'https://github.com/lensfun/lensfun';

export interface VignettingCalib { focal: number; aperture: number; distance: number; k: [number, number, number] }
export interface LensfunLens {
  maker: string;
  models: string[];
  mount: string;
  minFocal: number;
  maxFocal: number;
  sets: Array<{ crop: number; vignetting: VignettingCalib[] }>;
}

export interface VignettingResult { lensModel: string; k: [number, number, number]; rScale: number }

const attr = (s: string, name: string): string | null => {
  const m = s.match(new RegExp(`\\b${name}\\s*=\\s*"([^"]*)"`));
  return m ? m[1] : null;
};
const text = (s: string, tag: string): string[] =>
  [...s.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`, 'g'))].map((m) => decodeXml(m[1].trim()));
const decodeXml = (s: string) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

export function parseLensfunXml(xml: string): LensfunLens[] {
  const src = xml.replace(/<!--[\s\S]*?-->/g, '');
  const lenses: LensfunLens[] = [];
  for (const m of src.matchAll(/<lens>([\s\S]*?)<\/lens>/g)) {
    const body = m[1];
    const calibStart = body.search(/<calibration[\s>]/);
    const head = calibStart >= 0 ? body.slice(0, calibStart) : body;
    const lensCrop = parseFloat(text(head, 'cropfactor')[0] ?? 'NaN');
    const focalTag = head.match(/<focal\s[^>]*\/?>/)?.[0] ?? '';
    const fv = parseFloat(attr(focalTag, 'value') ?? 'NaN');
    const fmin = parseFloat(attr(focalTag, 'min') ?? 'NaN');
    const fmax = parseFloat(attr(focalTag, 'max') ?? 'NaN');
    const sets: LensfunLens['sets'] = [];
    for (const c of body.matchAll(/<calibration([^>]*)>([\s\S]*?)<\/calibration>/g)) {
      const crop = parseFloat(attr(c[1], 'cropfactor') ?? String(lensCrop));
      const vignetting: VignettingCalib[] = [];
      for (const v of c[2].matchAll(/<vignetting\s[^>]*\/>/g)) {
        const t = v[0];
        if (attr(t, 'model') !== 'pa') continue;
        const vals = ['focal', 'aperture', 'distance', 'k1', 'k2', 'k3'].map((n) => parseFloat(attr(t, n) ?? 'NaN'));
        if (vals.some((x) => !Number.isFinite(x))) continue;
        vignetting.push({ focal: vals[0], aperture: vals[1], distance: vals[2], k: [vals[3], vals[4], vals[5]] });
      }
      if (Number.isFinite(crop) && vignetting.length) sets.push({ crop, vignetting });
    }
    const focals = sets.flatMap((s) => s.vignetting.map((v) => v.focal));
    lenses.push({
      maker: text(head, 'maker')[0] ?? '',
      models: text(head, 'model'),
      mount: text(head, 'mount')[0] ?? '',
      minFocal: Number.isFinite(fmin) ? fmin : Number.isFinite(fv) ? fv : Math.min(...focals),
      maxFocal: Number.isFinite(fmax) ? fmax : Number.isFinite(fv) ? fv : Math.max(...focals),
      sets,
    });
  }
  return lenses;
}

/** "LUMIX G 20/F1.7 II" と "Lumix G 20mm f/1.7 II Asph." を同じ語の集合にそろえる */
export function lensTokens(name: string): Set<string> {
  const s = name
    .toLowerCase()
    .replace(/f\s*\/\s*/g, 'f')
    .replace(/(\d)\s*mm\b/g, '$1')
    .replace(/(\d)\s*\/\s*f/g, '$1 f');
  const tokens = s.split(/[^a-z0-9.]+/).map((t) => t.replace(/\.+$/, '')).filter(Boolean);
  const drop = new Set(['asph', 'aspherical', 'lens', 'mega', 'ois', 'o.i.s', 'power']);
  return new Set(tokens.filter((t) => !drop.has(t)));
}

/** 焦点距離と F 値の語が一致する候補のうち、語の一致率が最も高いものを選ぶ */
export function matchLens(name: string, lenses: LensfunLens[]): { lens: LensfunLens; model: string } | null {
  const a = lensTokens(name);
  const nums = [...a].filter((t) => /\d/.test(t));
  let best: { lens: LensfunLens; model: string; score: number } | null = null;
  for (const lens of lenses) {
    if (!lens.sets.length) continue;
    for (const model of lens.models) {
      const b = lensTokens(model);
      if (!nums.every((t) => b.has(t))) continue;
      if ([...b].some((t) => /\d/.test(t) && !a.has(t))) continue;
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      const score = inter / (a.size + b.size - inter);
      if (!best || score > best.score) best = { lens, model, score };
    }
  }
  return best && best.score >= 0.5 ? { lens: best.lens, model: best.model } : null;
}

/** Lensfun の lfLens::InterpolateVignetting と同じ逆距離加重（p = 3.5） */
export function interpolateVignetting(
  lens: LensfunLens,
  cropImage: number,
  focal: number,
  aperture: number,
  distance = 1000,
): { k: [number, number, number]; crop: number } | null {
  let set: LensfunLens['sets'][number] | null = null;
  let ratio = Infinity;
  for (const s of lens.sets) {
    const r = cropImage / s.crop;
    if (r >= 0.96 && r < ratio) { ratio = r; set = s; }
  }
  if (!set) return null;
  const df = lens.maxFocal - lens.minFocal;
  const norm = (f: number) => (df ? (f - lens.minFocal) / df : f - lens.minFocal);
  const k: [number, number, number] = [0, 0, 0];
  let total = 0;
  let smallest = Infinity;
  for (const c of set.vignetting) {
    const d = Math.hypot(norm(c.focal) - norm(focal), 4 / c.aperture - 4 / aperture, 0.1 / c.distance - 0.1 / distance);
    if (d < 1e-4) return { k: [...c.k], crop: set.crop };
    smallest = Math.min(smallest, d);
    const w = 1 / d ** 3.5;
    // pa の係数は焦点距離でスケールしてから平均し、最後に撮影時の焦点距離で戻す（Lensfun と同じ）
    for (let i = 0; i < 3; i++) k[i] += w * c.k[i] * c.focal;
    total += w;
  }
  if (smallest > 1 || !total) return null;
  return { k: [k[0] / (total * focal), k[1] / (total * focal), k[2] / (total * focal)], crop: set.crop };
}

const DB_FOR: Array<[RegExp, string]> = [
  [/lumix|leica|panasonic|dg\b/i, 'mil-panasonic.xml'],
  [/olympus|zuiko|\bom\b|om system/i, 'mil-olympus.xml'],
];

const dbCache = new Map<string, Promise<LensfunLens[]>>();
function loadDb(file: string): Promise<LensfunLens[]> {
  let p = dbCache.get(file);
  if (!p) {
    const url = `https://raw.githubusercontent.com/lensfun/lensfun/${LENSFUN_COMMIT}/data/db/${file}`;
    p = fetch(url).then(async (res) => {
      if (!res.ok) throw new Error(`Lensfun（${file}）を取得できませんでした（HTTP ${res.status}）`);
      return parseLensfunXml(await res.text());
    });
    p.catch(() => dbCache.delete(file));
    dbCache.set(file, p);
  }
  return p;
}

/** マイクロフォーサーズ（クロップ 2.0）用。該当レンズがなければ null */
export async function findVignetting(lensName: string, focal: number, aperture: number, cropImage = 2.0): Promise<VignettingResult | null> {
  const files = DB_FOR.filter(([re]) => re.test(lensName)).map(([, f]) => f);
  for (const file of files.length ? files : DB_FOR.map(([, f]) => f)) {
    const hit = matchLens(lensName, await loadDb(file));
    if (!hit) continue;
    const v = interpolateVignetting(hit.lens, cropImage, focal, aperture);
    if (v) return { lensModel: hit.model, k: v.k, rScale: v.crop / cropImage };
  }
  return null;
}
