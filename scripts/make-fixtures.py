"""テスト用の期待値を colour-science で独立に計算する（開発用）。

python3 scripts/make-fixtures.py > test/fixtures.json
ついでに test/synthetic.cube（なめらかだが非線形な合成 LUT）も書き出す。
"""
import json, sys
import numpy as np
import colour
from colour.algebra import table_interpolation_tetrahedral

rng = np.random.default_rng(7)
REC2020 = colour.RGB_COLOURSPACES['ITU-R BT.2020']

def u16(a):
    return np.clip(np.round(a * 65535), 0, 65535).astype(np.int64)

src = u16(np.concatenate([rng.random((40, 3)) ** 2.2 * 0.9, [[0.18 * 0.5] * 3, [0.05, 0.1, 0.4], [0.6, 0.3, 0.1]]]))
lin = src / 65535.0

out = {'src': src.flatten().tolist(), 'cases': []}

# 合成 LUT: 色の混ざりとトーンカーブを持つなめらかな関数
N = 17
g = np.linspace(0, 1, N)
B, G, R = np.meshgrid(g, g, g, indexing='ij')
r = 0.75 * R ** 0.9 + 0.2 * G * B + 0.05 * np.sin(3 * B)
gg = 0.8 * G ** 1.1 + 0.15 * R * (1 - B) + 0.05 * B
b = 0.7 * B ** 1.2 + 0.25 * np.sqrt(G * R) + 0.03
table = np.stack([r, gg, b], -1)  # [b][g][r][c]
with open('test/synthetic.cube', 'w') as f:
    f.write('TITLE "synthetic"\n# test only\nLUT_3D_SIZE %d\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n' % N)
    for row in table.reshape(-1, 3):
        f.write('%.6f %.6f %.6f\n' % tuple(row))
L = colour.read_LUT('test/synthetic.cube')

def ycube(enc):
    return table_interpolation_tetrahedral(np.clip(enc, 0, 1), L.table)

M = colour.matrix_RGB_to_RGB(REC2020, colour.RGB_COLOURSPACES['sRGB'], chromatic_adaptation_transform=None)
Mp3 = colour.matrix_RGB_to_RGB(REC2020, colour.RGB_COLOURSPACES['Display P3'], chromatic_adaptation_transform=None)
Mfc = colour.matrix_RGB_to_RGB(REC2020, colour.RGB_COLOURSPACES['F-Gamut C'], chromatic_adaptation_transform=None)
P3S = colour.matrix_RGB_to_RGB(colour.RGB_COLOURSPACES['Display P3'], colour.RGB_COLOURSPACES['sRGB'], chromatic_adaptation_transform=None)
flog2 = lambda x: colour.models.log_encoding_FLog2(x)
flog = lambda x: colour.models.log_encoding_FLog(x)
for ev in (0.0, 0.7, -1.3):
    # 1) sRGB リニアコントラスト入力（abpy 形式, 基準 -0.88EV）
    gain = 2 ** (ev - 0.88)
    y = ycube(colour.models.eotf_inverse_sRGB(np.clip((lin * gain) @ M.T, 0, 1)))
    out['cases'].append({'name': 'synthetic-srgb', 'input': 'srgb', 'output': 'srgb', 'ev': ev, 'expected': (np.clip(y, 0, 1) * 255).flatten().tolist()})
    # 2) P3 入力・P3 出力 → sRGB へ
    y = ycube(colour.models.eotf_inverse_sRGB(np.clip((lin * gain) @ Mp3.T, 0, 1)))
    y = colour.models.eotf_inverse_sRGB(np.clip(colour.models.eotf_sRGB(np.clip(y, 0, 1)) @ P3S.T, 0, 1))
    out['cases'].append({'name': 'synthetic-p3', 'input': 'p3', 'output': 'p3', 'ev': ev, 'expected': (y * 255).flatten().tolist()})
    # 3) F-Log2 / F-Log2 C / F-Log
    gain = 2 ** ev
    for name, enc in (('flog2', flog2(lin * gain)), ('flog2c', flog2(np.maximum((lin * gain) @ Mfc.T, 0))), ('flog', flog(lin * gain))):
        y = ycube(enc)
        out['cases'].append({'name': 'synthetic-' + name, 'input': name, 'output': 'srgb', 'ev': ev, 'expected': (np.clip(y, 0, 1) * 255).flatten().tolist()})

# 2) ニュートラルの真値：シーンリニア Rec.2020 → sRGB 原色でクリップ → sRGB 符号化
Mf = colour.matrix_RGB_to_RGB(colour.RGB_COLOURSPACES['F-Gamut'], colour.RGB_COLOURSPACES['sRGB'], chromatic_adaptation_transform=None)
for ev in (0.0, 1.0):
    x = np.clip((lin * 2 ** ev) @ Mf.T, 0, 1)
    y = colour.models.eotf_inverse_sRGB(x)
    out['cases'].append({'name': 'neutral-flog2', 'input': 'flog2', 'output': 'srgb', 'ev': ev, 'expected': (y * 255).flatten().tolist()})

# 3) F-Log2 符号化値そのもの
out['flog2'] = {str(v): float(colour.models.log_encoding_FLog2(v)) for v in (0.0, 0.0005, 0.18, 1.0, 10.0)}
out['matrices'] = {
    'REC2020_TO_SRGB': M.flatten().tolist(),
    'REC2020_TO_FGAMUTC': colour.matrix_RGB_to_RGB(REC2020, colour.RGB_COLOURSPACES['F-Gamut C'], chromatic_adaptation_transform=None).flatten().tolist(),
    'P3_TO_SRGB': colour.matrix_RGB_to_RGB(colour.RGB_COLOURSPACES['Display P3'], colour.RGB_COLOURSPACES['sRGB'], chromatic_adaptation_transform=None).flatten().tolist(),
}
json.dump(out, sys.stdout)
