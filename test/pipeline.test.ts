// node --test test/  （Node 22.18+ の型ストリップで .ts をそのまま実行）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { P3_TO_SRGB, REC2020_TO_FGAMUTC, REC2020_TO_SRGB, FLOG2, logDecode, logEncode, type InputSpace, type OutputSpace } from '../src/color.ts';
import { CubeError, makeIdentityLut, parseCube } from '../src/cube.ts';
import { downscale, medianLuma, renderRGBA } from '../src/render.ts';
import { guessInput } from '../src/luts.ts';

const fx = JSON.parse(readFileSync(new URL('./fixtures.json', import.meta.url), 'utf8')) as {
  src: number[];
  cases: Array<{ name: string; input: InputSpace; output: OutputSpace; ev: number; expected: number[] }>;
  flog2: Record<string, number>;
  matrices: Record<string, number[]>;
};
const synthetic = parseCube(readFileSync(new URL('./synthetic.cube', import.meta.url), 'utf8'));

test('色変換行列が colour-science と一致する', () => {
  const pairs: Array<[string, readonly number[]]> = [
    ['REC2020_TO_SRGB', REC2020_TO_SRGB],
    ['REC2020_TO_FGAMUTC', REC2020_TO_FGAMUTC],
    ['P3_TO_SRGB', P3_TO_SRGB],
  ];
  for (const [k, m] of pairs) {
    // colour の sRGB は IEC 規格の丸めた行列を使うので 1e-3 まで許容（こちらは原色から厳密に導出）
    fx.matrices[k].forEach((v, i) => assert.ok(Math.abs(v - m[i]) < 1e-3, `${k}[${i}] ${m[i]} != ${v}`));
  }
});

test('F-Log2 の符号化（18% グレー = 0.391）と往復', () => {
  for (const [x, y] of Object.entries(fx.flog2)) {
    assert.ok(Math.abs(logEncode(+x, FLOG2) - y) < 1e-9, `F-Log2(${x})`);
    assert.ok(Math.abs(logDecode(y, FLOG2) - +x) < 1e-6 * Math.max(1, +x));
  }
  assert.equal(Math.round(logEncode(0.18, FLOG2) * 1023), 400);
});

test('全モードで colour-science の四面体補間と一致する（±1/255）', () => {
  const src = Uint16Array.from(fx.src);
  const n = src.length / 3;
  for (const c of fx.cases.filter((c) => c.name.startsWith('synthetic'))) {
    const out = new Uint8ClampedArray(n * 4);
    renderRGBA(src, { lut: synthetic, input: c.input, output: c.output, ev: c.ev }, out);
    let worst = 0;
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out[i * 4 + k] - c.expected[i * 3 + k]));
    assert.ok(worst <= 1, `${c.name} ev=${c.ev}: 最大誤差 ${worst}`);
  }
});

test('ニュートラルはシーンリニアを厳密に sRGB にする（±1/255）', () => {
  const src = Uint16Array.from(fx.src);
  const n = src.length / 3;
  for (const c of fx.cases.filter((c) => c.name === 'neutral-flog2')) {
    const out = new Uint8ClampedArray(n * 4);
    renderRGBA(src, { lut: makeIdentityLut(), input: 'scene', output: 'srgb', ev: c.ev }, out);
    let worst = 0;
    for (let i = 0; i < n; i++)
      for (let k = 0; k < 3; k++) worst = Math.max(worst, Math.abs(out[i * 4 + k] - c.expected[i * 3 + k]));
    assert.ok(worst <= 1, `ev=${c.ev}: 最大誤差 ${worst}`);
  }
});

test('18% グレーはニュートラルで sRGB 118 になる', () => {
  const g = Math.round(0.18 * 65535);
  const out = new Uint8ClampedArray(4);
  renderRGBA(Uint16Array.of(g, g, g), { lut: makeIdentityLut(), input: 'scene', output: 'srgb', ev: 0 }, out);
  assert.deepEqual([...out], [118, 118, 118, 255]);
});

test('部分範囲の描画（書き出しの帯処理）は全体描画と同じ結果になる', () => {
  const src = Uint16Array.from(fx.src);
  const n = src.length / 3;
  const p = { lut: synthetic, input: 'flog2' as const, output: 'srgb' as const, ev: 0.3 };
  const all = new Uint8ClampedArray(n * 4);
  renderRGBA(src, p, all);
  const part = new Uint8ClampedArray(10 * 4);
  renderRGBA(src, p, part, 5, 10);
  assert.deepEqual([...part], [...all.subarray(20, 60)]);
});

test('.cube パーサ', () => {
  const lut = parseCube('TITLE "t"\n# c\nLUT_3D_SIZE 2\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 2 2 2\n' + '0 0 0\n'.repeat(8));
  assert.equal(lut.size, 2);
  assert.equal(lut.title, 't');
  assert.deepEqual(lut.domainMax, [2, 2, 2]);
  assert.throws(() => parseCube('LUT_3D_SIZE 2\n0 0 0\n'), CubeError);
  assert.throws(() => parseCube('LUT_1D_SIZE 4\n0 0 0\n'), CubeError);
  assert.throws(() => parseCube('0 0 0\n'), CubeError);
});

test('ファイル名から入力を推測する', () => {
  assert.equal(guessInput('FLog2C_to_PROVIA_65grid_V.1.00.cube'), 'flog2c');
  assert.equal(guessInput('F-Log2 C to CLASSIC CHROME.cube'), 'flog2c');
  assert.equal(guessInput('F-Log2_to_ETERNA_33grid.cube'), 'flog2');
  assert.equal(guessInput('XT3_FLog_FGamut_to_ETERNA_BT.709_33grit.cube'), 'flog');
  assert.equal(guessInput('provia_sRGB.cube'), 'srgb');
  assert.equal(guessInput('provia_DisplayP3.cube'), 'p3');
});

test('縮小はリニアのまま平均し、中央値を返す', () => {
  const w = 4, h = 2;
  const src = new Uint16Array(w * h * 3);
  for (let i = 0; i < w * h; i++) src.fill(i % 2 ? 1000 : 3000, i * 3, i * 3 + 3);
  const d = downscale(src, w, h, 2);
  assert.equal(d.width, 2);
  assert.equal(d.height, 1);
  assert.deepEqual([...d.data], [2000, 2000, 2000, 2000, 2000, 2000]);
  assert.ok(Math.abs(medianLuma(d.data) - 2000 / 65535) < 1e-6);
});
