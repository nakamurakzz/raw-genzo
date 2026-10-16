#!/usr/bin/env bash
# LibRaw を WebAssembly にビルドして vendor/libraw/ に置く。
#
#   必要なもの: em++ / emar（Emscripten）, git
#   使い方:     scripts/build-libraw.sh
#
# 方針
#   - LibRaw はタグとコミットハッシュの両方で固定する。
#   - LibRaw 本体だけを入れる。LCMS（ICC プロファイル）・libjpeg（非可逆 DNG / Kodak）・
#     zlib（Deflate 圧縮 DNG）は使わないので入れない（攻撃面を減らす）。
#   - シングルスレッド（SharedArrayBuffer 不要）。
#   - -sDYNAMIC_EXECUTION=0 で embind が new Function を使わないようにする（CSP に unsafe-eval が要らない）。
#   - -ffast-math は使わない（NaN チェックを最適化で消さないため）。
#   - C++ ラッパー（libraw_wrapper.cpp）と index.js は libraw-wasm v1.6.0（ISC）をそのまま使う。
set -euo pipefail

LIBRAW_TAG=0.22.2
LIBRAW_COMMIT=b93f6e45c194f5df9b02a43b1af9a54b4f41f33f
WRAPPER_TAG=v1.6.0
WRAPPER_COMMIT=32fd36a9883a10c1632bc20073f1ea88cc60487a

ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=${WORK:-$ROOT/.build-libraw}
OUT=$ROOT/vendor/libraw
JOBS=${JOBS:-$(nproc 2>/dev/null || echo 2)}

command -v em++ >/dev/null || { echo "em++ が見つかりません。emsdk を入れるか、Docker の emscripten/emsdk イメージの中で実行してください。" >&2; exit 1; }
mkdir -p "$WORK" "$OUT"
cd "$WORK"

fetch() { # url tag commit dir
  [ -d "$4" ] || git clone -q --depth 1 --branch "$2" "$1" "$4"
  local head; head=$(git -C "$4" rev-parse HEAD)
  [ "$head" = "$3" ] || { echo "$4: コミットが一致しません（$head != $3）" >&2; exit 1; }
}
fetch https://github.com/LibRaw/LibRaw.git "$LIBRAW_TAG" "$LIBRAW_COMMIT" LibRaw
fetch https://github.com/ybouane/LibRaw-Wasm.git "$WRAPPER_TAG" "$WRAPPER_COMMIT" LibRaw-Wasm

FLAGS="-O3 -msimd128 -DNDEBUG -DLIBRAW_NOTHREADS -sDISABLE_EXCEPTION_CATCHING=0 -ILibRaw -w"

echo "==> LibRaw $LIBRAW_TAG をコンパイル"
mkdir -p obj
OBJS=$(sed -n '/^LIB_OBJECTS=/,/^$/p' LibRaw/Makefile.dist | grep -o 'object/[a-z0-9_]*\.o' | sed 's#object/##; s#\.o$##')
for name in $OBJS; do
  src=$(find LibRaw/src -name "$name.cpp" | head -1)
  [ -n "$src" ] || { echo "ソースが見つかりません: $name.cpp" >&2; exit 1; }
  echo "$src obj/$name.o"
done | xargs -P "$JOBS" -n 2 sh -c 'em++ '"$FLAGS"' -c "$0" -o "$1"'
rm -f libraw.a
emar rcs libraw.a obj/*.o

echo "==> ラッパーとリンク"
# リンク時の最適化は -O2（コード生成は上の -O3 で済んでいる。-O3 だと wasm-metadce が要る）
em++ ${FLAGS/-O3/-O2} --bind LibRaw-Wasm/libraw_wrapper.cpp libraw.a \
  -sMODULARIZE=1 -sEXPORT_ES6=1 -sENVIRONMENT=web,worker \
  -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=64MB -sMAXIMUM_MEMORY=2GB \
  -sWASM_BIGINT=1 -sDYNAMIC_EXECUTION=0 -sEXPORT_EXCEPTION_HANDLING_HELPERS=1 \
  -o "$OUT/libraw.js"

if grep -q 'new Function' "$OUT/libraw.js"; then
  echo "libraw.js に new Function が残っています（CSP で unsafe-eval が必要になる）" >&2
  exit 1
fi

cp LibRaw-Wasm/index.js "$OUT/index.js"
cp LibRaw-Wasm/index.d.ts "$OUT/index.d.ts"
cp "$ROOT/scripts/libraw-worker.js" "$OUT/worker.js"
cp LibRaw/LICENSE.LGPL "$OUT/LICENSE.LibRaw.LGPL"
cp LibRaw/LICENSE.CDDL "$OUT/LICENSE.LibRaw.CDDL"
cp LibRaw/COPYRIGHT "$OUT/COPYRIGHT.LibRaw"
cat > "$OUT/LICENSE.libraw-wasm" <<'EOF_ISC'
libraw-wasm (https://github.com/ybouane/LibRaw-Wasm) - libraw_wrapper.cpp, index.js, index.d.ts, worker.js (modified)
ISC License, Copyright (c) ybouane and contributors

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES
WITH REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF
MERCHANTABILITY AND FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR
ANY SPECIAL, DIRECT, INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES
WHATSOEVER RESULTING FROM LOSS OF USE, DATA OR PROFITS, WHETHER IN AN
ACTION OF CONTRACT, NEGLIGENCE OR OTHER TORTIOUS ACTION, ARISING OUT OF
OR IN CONNECTION WITH THE USE OR PERFORMANCE OF THIS SOFTWARE.
EOF_ISC

cat > "$OUT/BUILD-INFO.txt" <<EOF
LibRaw        $LIBRAW_TAG ($LIBRAW_COMMIT)  LGPL-2.1 / CDDL-1.0
libraw-wasm   $WRAPPER_TAG ($WRAPPER_COMMIT)  ISC  (libraw_wrapper.cpp, index.js, index.d.ts)
emscripten    $(em++ --version | head -1)
llvm          $(em++ -v 2>&1 | grep -m1 'clang version' || true)
built         $(date -u +%Y-%m-%dT%H:%M:%SZ)
sha256        $(cd "$OUT" && sha256sum libraw.wasm libraw.js index.js worker.js | tr '\n' ' ')
EOF
echo "==> 完了: $OUT"
cat "$OUT/BUILD-INFO.txt"
