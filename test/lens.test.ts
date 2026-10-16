import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEADROOM, autoScale, correctRows, distortForward, distortInverse } from '../src/lens.ts';
import { interpolateVignetting, matchLens, parseLensfunXml } from '../src/lensfun.ts';
import { parseDistortionInfo, readRw2LensMeta } from '../src/rw2meta.ts';

// ---------- 合成 RW2 ----------
// IFD0: 0x0119（DistortionInfo）と 0x002E（JpgFromRaw）。JPEG の中に Exif / Panasonic メーカーノート。
function buildRw2(opts: { flag?: number; shading?: number; lens?: string } = {}): Uint8Array {
  const { flag = 1, shading = 0, lens = 'LUMIX G 20/F1.7 II' } = opts;
  const words = new Int16Array(16);
  words[4] = 473; // b
  words[5] = 0; // scale
  words[7] = flag;
  words[8] = 1867; // a
  words[11] = -354; // c
  words[12] = 2500;

  // --- Exif TIFF（リトルエンディアン） ---
  const t: number[] = [];
  const u16 = (a: number[], v: number) => a.push(v & 0xff, (v >> 8) & 0xff);
  const u32 = (a: number[], v: number) => a.push(v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff, (v >>> 24) & 0xff);
  const lensBytes = [...new TextEncoder().encode(lens), 0];
  // レイアウト: header(8) | IFD0 @8 (1 entry, 〜26) | ExifIFD @26 (3 entries, 〜68) | data @72
  const exifIfd = 26, data = 72;
  const fnum = data, focal = data + 8, mn = data + 16;
  const mnIfd = mn + 12;
  const lensOff = mnIfd + 2 + 2 * 12 + 4;
  t.push(0x49, 0x49); u16(t, 42); u32(t, 8);
  u16(t, 1); u16(t, 0x8769); u16(t, 4); u32(t, 1); u32(t, exifIfd); u32(t, 0);
  while (t.length < exifIfd) t.push(0);
  u16(t, 3);
  u16(t, 0x829d); u16(t, 5); u32(t, 1); u32(t, fnum);
  u16(t, 0x920a); u16(t, 5); u32(t, 1); u32(t, focal);
  const mnLen = 12 + 2 + 2 * 12 + 4 + lensBytes.length;
  u16(t, 0x927c); u16(t, 7); u32(t, mnLen); u32(t, mn);
  u32(t, 0);
  assert.ok(t.length <= data);
  while (t.length < data) t.push(0);
  u32(t, 40); u32(t, 10); // F4.0
  u32(t, 20); u32(t, 1); // 20mm
  t.push(...new TextEncoder().encode('Panasonic'), 0, 0, 0);
  u16(t, 2);
  u16(t, 0x0051); u16(t, 2); u32(t, lensBytes.length); u32(t, lensOff);
  u16(t, 0x008a); u16(t, 3); u32(t, 1); u32(t, shading);
  u32(t, 0);
  t.push(...lensBytes);

  // --- JPEG（SOI + APP1 + EOI だけ） ---
  const app1Len = 2 + 6 + t.length;
  const jpg = [0xff, 0xd8, 0xff, 0xe1, (app1Len >> 8) & 0xff, app1Len & 0xff, 0x45, 0x78, 0x69, 0x66, 0, 0, ...t, 0xff, 0xd9];

  // --- RW2 本体 ---
  const r: number[] = [];
  const di = 8 + 2 + 2 * 12 + 4;
  const jp = di + 32;
  r.push(0x49, 0x49); u16(r, 0x55); u32(r, 8);
  u16(r, 2);
  u16(r, 0x002e); u16(r, 7); u32(r, jpg.length); u32(r, jp);
  u16(r, 0x0119); u16(r, 7); u32(r, 32); u32(r, di);
  u32(r, 0);
  for (const w of words) u16(r, w & 0xffff);
  r.push(...jpg);
  return Uint8Array.from(r);
}

test('RW2 から歪曲係数・レンズ名・シェーディング補正・F 値・焦点距離を読む', () => {
  const m = readRw2LensMeta(buildRw2());
  assert.equal(m.lensName, 'LUMIX G 20/F1.7 II');
  assert.equal(m.aperture, 4);
  assert.equal(m.focal, 20);
  assert.equal(m.shadingCompensation, false);
  assert.ok(m.distortion);
  assert.ok(Math.abs(m.distortion.a - 1867 / 32768) < 1e-12);
  assert.ok(Math.abs(m.distortion.b - 473 / 32768) < 1e-12);
  assert.ok(Math.abs(m.distortion.c + 354 / 32768) < 1e-12);
  assert.equal(readRw2LensMeta(buildRw2({ shading: 1 })).shadingCompensation, true);
  assert.equal(readRw2LensMeta(buildRw2({ flag: 0 })).distortion, null);
});

test('壊れた・別形式のファイルでも例外を出さない', () => {
  const good = buildRw2();
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  for (let i = 0; i < 3000; i++) {
    const b = good.slice(0, Math.floor(rnd() * good.length) + 1);
    for (let j = 0; j < 4; j++) b[Math.floor(rnd() * b.length)] = Math.floor(rnd() * 256);
    assert.doesNotThrow(() => readRw2LensMeta(b));
  }
  assert.deepEqual(readRw2LensMeta(new Uint8Array([0xff, 0xd8, 0xff, 0xe0])).distortion, null);
});

test('DistortionScale は係数に掛かる', () => {
  const w = new Int16Array(16);
  w[7] = 1; w[8] = 3276; w[5] = 3276;
  const d = parseDistortionInfo(w)!;
  assert.ok(Math.abs(d.a - (3276 / 32768) / (1 + 3276 / 32768)) < 1e-12);
});

test('歪曲の逆関数', () => {
  const d = { a: 0.057, b: 0.0144, c: -0.0108 };
  for (const r of [0, 0.1, 0.5, 0.9, 1.0, 1.04]) {
    assert.ok(Math.abs(distortForward(d, distortInverse(d, r)) - r) < 1e-9);
  }
});

test('樽型の補正は縮小不要、糸巻き型は縮小して枠内に収める', () => {
  assert.equal(autoScale({ a: 0.057, b: 0.0144, c: -0.0108 }, 400, 300), 1);
  const pin = { a: -0.08, b: 0, c: 0 };
  const k = autoScale(pin, 400, 300);
  assert.ok(k < 1 && k > 0.9, `k=${k}`);
  // 角の画素が元画像の範囲に入っていること
  const hd = Math.hypot(400, 300) / 2, cx = 199.5, cy = 149.5;
  const r = Math.hypot(cx, cy) / hd;
  const s = distortInverse(pin, k * r) / r;
  assert.ok(Math.abs(cx * s) <= cx + 1e-6 && Math.abs(cy * s) <= cy + 1e-6);
});

test('係数ゼロの補正は 1/HEADROOM 倍するだけ（整数位置の双三次補間は元の値と一致）', () => {
  const w = 7, h = 5;
  const src = new Uint16Array(w * h * 3).map((_, i) => (i * 977) % 60000);
  const out = new Uint16Array(w * h * 3);
  correctRows(src, w, h, { distortion: { a: 0, b: 0, c: 0 }, vignetting: { k: [0, 0, 0], rScale: 1 } }, 1, out, 0, h);
  for (let i = 0; i < src.length; i++) assert.equal(out[i], Math.round(src[i] / HEADROOM));
});

const XML = `<lensdatabase version="2">
<!-- テスト用の架空データ -->
<lens>
  <maker>Panasonic</maker><model>Lumix G 20mm f/1.7 Asph.</model><mount>Micro 4/3 System</mount>
  <focal value="20"/><cropfactor>2</cropfactor>
  <calibration><vignetting model="pa" focal="20" aperture="4" distance="1000" k1="-0.9" k2="0" k3="0"/></calibration>
</lens>
<lens>
  <maker>Panasonic</maker><model>Lumix G 20mm f/1.7 II Asph.</model><mount>Micro 4/3 System</mount>
  <cropfactor>2</cropfactor>
  <calibration>
    <vignetting model="pa" focal="20" aperture="2" distance="1000" k1="-0.4" k2="0.1" k3="0"/>
    <vignetting model="pa" focal="20" aperture="4" distance="1000" k1="-0.2" k2="0.05" k3="0"/>
  </calibration>
</lens>
</lensdatabase>`;

test('Lensfun: II 型を取り違えずに選び、絞りで補間する', () => {
  const db = parseLensfunXml(XML);
  const hit = matchLens('LUMIX G 20/F1.7 II', db)!;
  assert.equal(hit.model, 'Lumix G 20mm f/1.7 II Asph.');
  assert.equal(matchLens('LUMIX G 20/F1.7', db)!.model, 'Lumix G 20mm f/1.7 Asph.');
  assert.equal(matchLens('LUMIX G 25/F1.7', db), null);
  assert.deepEqual(interpolateVignetting(hit.lens, 2, 20, 4)!.k, [-0.2, 0.05, 0]);
  const mid = interpolateVignetting(hit.lens, 2, 20, 2.8)!.k;
  assert.ok(mid[0] > -0.4 && mid[0] < -0.2);
  // クロップ係数が大きく違う（フルサイズ等）ときは使わない
  assert.equal(interpolateVignetting(hit.lens, 1.0, 20, 4), null);
});
