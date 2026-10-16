# LUT現像所（raw-genzo）

LUMIX GM1 などの RAW を、富士フイルムのフィルムシミュレーション LUT でブラウザ内だけで現像するツール。
サーバー処理はなく、Cloudflare Workers は静的ファイルを配るだけ。画像はブラウザの外に出ない。

> 富士フイルム・パナソニックとは関係のない、個人の非公式プロジェクトです。

## パイプライン

```
RW2 ──LibRaw(wasm)──▶ リニア Rec.2020 / 16bit / カメラWB / 自動明るさ補正なし
     ──▶ レンズ補正（リニアのまま）
           歪曲    : RW2 内蔵の係数で再サンプリング（双三次補間）
           周辺減光: Lensfun の pa モデルでゲイン
     ──×露出（自動: 埋め込みJPEGと輝度の中央値を合わせる ＋ 補正 ±3EV）
     ──▶ LUT の入力に合わせて変換
           F-Log2   : F-Gamut = Rec.2020 なので行列なし → F-Log2 符号化
           F-Log2 C : Rec.2020 → F-Gamut C 行列 → F-Log2 符号化
           F-Log    : F-Log 符号化
           sRGB     : Rec.2020 → sRGB 行列 → クリップ → sRGB 符号化（基準 −0.88EV）
     ──▶ 3D LUT（四面体補間）──▶ RGBA8 ──▶ プレビュー / JPEG 書き出し
```

- デコード: LibRaw 0.22.2 を WebAssembly にしたもの（`vendor/libraw/`、Web Worker で動く）。ラッパーは [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) v1.6.0 を流用し、ビルドは `scripts/build-libraw.sh` で自前で行っている（後述）。
- 色処理: `src/render.ts`（DOM 非依存の純粋関数、200 行弱）。別の Worker で回す。16MP の書き出しで 1 秒前後（歪曲補正ありで 2.5 秒前後）。
- 18% グレーは F-Log2 のコード値 0.391（10bit で 400）になる。富士フイルムのデータシートと一致。

## レンズ補正

| 補正 | データ源 | 実装 |
|---|---|---|
| 歪曲 | RW2 の IFD0 タグ 0x0119（DistortionInfo）。カメラ内 JPEG と同じ元データ | `src/rw2meta.ts` で読み、`src/lens.ts` で再サンプリング |
| 周辺減光 | [Lensfun](https://github.com/lensfun/lensfun) の DB（コミット固定で GitHub から取得） | `src/lensfun.ts` で照合・補間、`src/lens.ts` でゲイン |

- 歪曲の式は公開仕様がないため、Raphaël Rigo の解析（[trou/panasonic-rw2](https://github.com/trou/panasonic-rw2)）と darktable の実装に合わせた: `Ru = Rd·(1 + a·Rd² + b·Rd⁴ + c·Rd⁶)`、半径は対角線の半分で正規化、`a, b, c` = ワード 8, 4, 11 ÷ 32768 × スケール（ワード 5）。
- 周辺減光は Lensfun の `pa` モデル（角で r = 1）と、絞り・距離の逆距離加重補間を Lensfun と同じ式で実装。撮影距離は記録がないので無限遠とみなす。
- カメラ側のシェーディング補正が On の RAW は、二重補正になるので周辺減光補正を無効にする（darktable と同じ扱い）。
- 補正で周辺が明るくなっても白飛びしないよう、補正後のデータは 1 段の余裕（1/2 倍）を持たせて保持し、描画時に戻す。
- 自動露出（カメラ JPEG に合わせる明るさ）は補正前の画像で測る。
- Lensfun の DB は RW2 を開いたときに取得する（送るのは DB の URL へのリクエストだけで、画像は送らない）。

## 使い方

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # 色変換と LUT 補間のテスト（colour-science で作った期待値と比較）
```

### LibRaw（wasm）の再ビルド

`vendor/libraw/` にビルド済みのものを置いてあるので、普段は何もしなくてよい。LibRaw を更新するときだけ:

```bash
# Emscripten が入った環境で（emsdk か Docker の emscripten/emsdk イメージ）
npm run build:libraw   # LibRaw のタグとコミットハッシュは scripts/build-libraw.sh の先頭で固定
```

ビルドの方針:
- LibRaw 本体だけを入れる。LCMS（ICC）、libjpeg（非可逆 DNG / Kodak）、zlib（Deflate DNG）は入れない。
- シングルスレッド（SharedArrayBuffer 不要）。
- `-sDYNAMIC_EXECUTION=0` で `new Function` を使わない（CSP に `unsafe-eval` が要らない）。
- `-ffast-math` は使わない（NaN チェックを最適化で消さないため）。
- 使ったツールとハッシュは `vendor/libraw/BUILD-INFO.txt` に残る。

### セキュリティヘッダ

`public/_headers` で CSP（外部への通信は `raw.githubusercontent.com` だけ許可、eval 禁止）と COOP / COEP を付けている。`npm run preview` でも同じヘッダが付くので、本番と同じ条件で確認できる（`npm run dev` には付かない）。

### Cloudflare Workers にデプロイ

```bash
npx wrangler login
npm run deploy       # vite build → wrangler deploy（静的アセットのみの Worker）
```

`wrangler.jsonc` は `assets.directory = ./dist` だけの構成。Worker スクリプトは不要。
キャッシュ用のヘッダーは `public/_headers` に書いてある。

## LUT の入手

| 種類 | 入手方法 | 入力 |
|---|---|---|
| 富士フイルム公式（F-Log2 / F-Log2 C → PROVIA, CLASSIC CHROME など 10 種） | [LUT ダウンロードページ](https://fujifilm-x.com/global/support/download/lut/)から機種の zip を落とし、zip のまま「LUT を追加」へ | ファイル名から自動判定。違っていたら一覧のセレクトで変更 |
| abpy/FujifilmCameraProfiles（11 種） | アプリ内の「abpy の LUT を読み込む」で GitHub から取得 | sRGB（リニアコントラスト） |
| 手持ちの .cube | 「LUT を追加」 | 既定は F-Log2。セレクトで変更 |

読み込んだ LUT はこのブラウザの IndexedDB に保存されるので、次回は入れ直さなくてよい。

公式 LUT の出力は、富士フイルムのホワイトペーパーにある推奨モニター設定（Rec.709 / D65 / ガンマ 2.2）を根拠に sRGB 相当として扱っている。

## 検証したこと

- LibRaw の出力が rawpy（LibRaw 0.22）の Rec.2020 リニア出力と一致する。
- 合成 LUT を使い、5 つの入力モードすべてで colour-science の四面体補間と ±1/255 以内で一致する（`npm test`）。
- 実際の RW2（DMC-GF1 / DMC-GM1）を headless Chromium で開き、プレビュー画素を rawpy＋colour-science で組んだ同じパイプラインと比べて、平均誤差 0.25/255。
- 歪曲補正: GM1＋LUMIX G 20mm F1.7 II の書き出しとカメラ内 JPEG を SIFT で対応付け、拡大・平行移動を除いた残差が補正なし 2.28px → 補正あり 0.25px（1920px 換算、どの半径でも 0.11px 以下）。
- 周辺減光: 同じレンズ・F1.7〜F9 で Lensfun 本体（lensfunpy）が出すゲインとの差が 0.06% 以内。
- RW2 パーサは合成データと、壊したデータ 3,000 通りで例外を出さないことを確認（`npm test`）。

## 制限

- グレイン、カラークロームエフェクト、D レンジ優先などの富士フイルムの追加処理は再現しない（LUT の範囲だけ）。
- 色の元データは LibRaw の（Adobe DNG 由来の）カメラ行列で、富士フイルムのセンサー×X-Processor とは別物。「かなり近い」止まり。
- ホワイトバランスは撮影時の設定のみ。
- レンズ補正の歪曲は Panasonic の RW2 のみ。周辺減光は Lensfun の Panasonic / Olympus の DB にあるレンズのみ（マイクロフォーサーズ前提）。倍率色収差の補正はしない。
- 書き出した JPEG に EXIF は付かない。
- 非可逆 DNG（スマホの DNG など）と Deflate 圧縮 DNG は読めない（libjpeg / zlib を入れていないため）。
- iPhone では「写真」ではなく「ファイル」から RW2 を選ぶ（写真アプリ経由だと JPEG に変換されることがある）。

## ライセンス

### このリポジトリのコード

[MIT License](LICENSE)。個人の趣味のプロジェクトで、作者は商用利用しない。

### 含まれている第三者のもの

詳細とライセンス本文は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。配信サイトでも `/THIRD_PARTY_NOTICES.txt` で読める。

| もの | ライセンス | 備考 |
|---|---|---|
| LibRaw 0.22.2（`vendor/libraw/libraw.wasm`） | LGPL-2.1 / CDDL-1.0 | 改変なし。ソースのコミットと再ビルド手順は `scripts/build-libraw.sh` |
| libraw-wasm v1.6.0（ラッパー・JS） | ISC | `worker.js` のみ改変 |
| Emscripten ランタイム、musl、LLVM libc++ | MIT / NCSA、MIT、Apache-2.0 WITH LLVM-exception | wasm と `libraw.js` に含まれる |
| fflate | MIT | |
| Barlow Semi Condensed | SIL OFL 1.1 | |

### 同梱していないもの（利用時に取得）

| もの | ライセンス | 取得のタイミング |
|---|---|---|
| Lensfun のレンズ DB | CC BY-SA 3.0 | RW2 を開いたとき |
| abpy/FujifilmCameraProfiles の LUT | **CC BY-NC-SA 4.0（非営利のみ）** | 「abpy の LUT を読み込む」を押したとき |
| 富士フイルム公式 LUT | 富士フイルムの利用条件 | 利用者が自分で読み込む |

abpy の LUT は非営利に限られる。このツールを有料化したり、広告や投げ銭を付けたりする場合は、abpy の取得機能を外すこと。

### 商標

FUJIFILM、PROVIA などのフィルムシミュレーション名は富士フイルム株式会社の、LUMIX はパナソニック ホールディングス株式会社の商標。説明のためだけに使っている。
