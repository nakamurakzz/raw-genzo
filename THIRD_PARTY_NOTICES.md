# Third-party notices / 第三者ソフトウェアとデータ

このリポジトリと、ビルドして配信するサイトに含まれる第三者のソフトウェア、および実行時に取得するデータの一覧です。
このリポジトリ自身のコードは MIT License（[LICENSE](LICENSE)）ですが、以下はそれぞれのライセンスに従います。

## 同梱しているもの（リポジトリ・配信サイトに含まれる）

| 名前 | 用途 | 場所 | ライセンス |
|---|---|---|---|
| [LibRaw](https://github.com/LibRaw/LibRaw) 0.22.2（コミット b93f6e45c194f5df9b02a43b1af9a54b4f41f33f） | RAW の展開（WebAssembly にビルド） | `vendor/libraw/libraw.wasm`, `libraw.js` | LGPL-2.1 または CDDL-1.0（`vendor/libraw/LICENSE.LibRaw.*`） |
| [libraw-wasm](https://github.com/ybouane/LibRaw-Wasm) v1.6.0 | LibRaw の C++ ラッパー、JS の呼び出し部分（worker.js は改変） | `vendor/libraw/` | ISC |
| [Emscripten](https://github.com/emscripten-core/emscripten) 3.1.52 のランタイム | wasm を読み込む JS（`libraw.js`） | `vendor/libraw/libraw.js` | MIT / University of Illinois NCSA |
| [musl libc](https://musl.libc.org/)（Emscripten 経由） | wasm に組み込まれる C 標準ライブラリ | `vendor/libraw/libraw.wasm` | MIT |
| LLVM libc++ / libc++abi / compiler-rt（Emscripten 経由） | wasm に組み込まれる C++ ランタイム | `vendor/libraw/libraw.wasm` | Apache-2.0 WITH LLVM-exception |
| [fflate](https://github.com/101arrowz/fflate) 0.8.3 | LUT の zip 展開 | ビルド後の JS | MIT |
| [Barlow Semi Condensed](https://github.com/jpt/barlow)（[@fontsource](https://fontsource.org/)） | 数字と LUT 名の書体 | ビルド後のフォントファイル | SIL Open Font License 1.1 |

### LibRaw の対応するソースについて（LGPL-2.1）

`vendor/libraw/libraw.wasm` は LibRaw 0.22.2 を改変せずに静的リンクしたものです。
対応するソースは LibRaw の公式リポジトリの上記コミットで、`scripts/build-libraw.sh` を実行すれば同じ構成で再ビルド・差し替えができます。

## 同梱していないもの（利用時に取得・読み込みする）

| 名前 | 取得のしかた | ライセンス・条件 |
|---|---|---|
| [Lensfun](https://github.com/lensfun/lensfun) のレンズデータベース | RW2 を開いたときに GitHub から取得（コミット固定） | CC BY-SA 3.0 |
| [abpy/FujifilmCameraProfiles](https://github.com/abpy/FujifilmCameraProfiles) の LUT | 利用者が「abpy の LUT を読み込む」を押したときに GitHub から取得 | CC BY-NC-SA 4.0（**非営利に限る**） |
| 富士フイルム公式の LUT | 利用者が自分でダウンロードして読み込む | 富士フイルムの利用条件に従う |

## 参考にしたもの（コードは含まない）

- Panasonic RW2 の歪曲補正データの解釈: Raphaël Rigo の解析（[trou/panasonic-rw2](https://github.com/trou/panasonic-rw2)）と、[darktable](https://github.com/darktable-org/darktable) の実装。式を独自に実装している。
- 周辺減光の補間: Lensfun の `lfLens::InterpolateVignetting` と同じ式を独自に実装している。
- F-Log / F-Log2 の式: 富士フイルムの公開データシート。
- テストの期待値は [colour-science](https://www.colour-science.org/)（BSD-3-Clause）で生成している（開発時のみ使用）。

## 商標

FUJIFILM、PROVIA、Velvia、ASTIA、CLASSIC CHROME、ETERNA、ACROS、REALA ACE は富士フイルム株式会社の、LUMIX と Panasonic はパナソニック ホールディングス株式会社の、Adobe と Lightroom は Adobe Inc. の商標または登録商標です。
このプロジェクトはこれらの企業とは関係のない個人のプロジェクトで、名称は説明のためだけに使っています。

---

## ライセンス本文

### Emscripten（MIT）

Copyright (c) 2010-2014 Emscripten authors, see AUTHORS file.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
THE SOFTWARE.

### musl libc（MIT）

Copyright © 2005-2020 Rich Felker, et al.

Permission is hereby granted, free of charge, to any person obtaining
a copy of this software and associated documentation files (the
"Software"), to deal in the Software without restriction, including
without limitation the rights to use, copy, modify, merge, publish,
distribute, sublicense, and/or sell copies of the Software, and to
permit persons to whom the Software is furnished to do so, subject to
the following conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.
IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY
CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT,
TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE
SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

### fflate（MIT）

MIT License

Copyright (c) 2026 Arjun Barrett

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

### libraw-wasm（ISC）

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

### Barlow Semi Condensed（SIL Open Font License 1.1）

Copyright 2017 The Barlow Project Authors (https://github.com/jpt/barlow)

This Font Software is licensed under the SIL Open Font License, Version 1.1.
This license is copied below, and is also available with a FAQ at:
http://scripts.sil.org/OFL


-----------------------------------------------------------
SIL OPEN FONT LICENSE Version 1.1 - 26 February 2007
-----------------------------------------------------------

PREAMBLE
The goals of the Open Font License (OFL) are to stimulate worldwide
development of collaborative font projects, to support the font creation
efforts of academic and linguistic communities, and to provide a free and
open framework in which fonts may be shared and improved in partnership
with others.

The OFL allows the licensed fonts to be used, studied, modified and
redistributed freely as long as they are not sold by themselves. The
fonts, including any derivative works, can be bundled, embedded,
redistributed and/or sold with any software provided that any reserved
names are not used by derivative works. The fonts and derivatives,
however, cannot be released under any other type of license. The
requirement for fonts to remain under this license does not apply
to any document created using the fonts or their derivatives.

DEFINITIONS
"Font Software" refers to the set of files released by the Copyright
Holder(s) under this license and clearly marked as such. This may
include source files, build scripts and documentation.

"Reserved Font Name" refers to any names specified as such after the
copyright statement(s).

"Original Version" refers to the collection of Font Software components as
distributed by the Copyright Holder(s).

"Modified Version" refers to any derivative made by adding to, deleting,
or substituting -- in part or in whole -- any of the components of the
Original Version, by changing formats or by porting the Font Software to a
new environment.

"Author" refers to any designer, engineer, programmer, technical
writer or other person who contributed to the Font Software.

PERMISSION & CONDITIONS
Permission is hereby granted, free of charge, to any person obtaining
a copy of the Font Software, to use, study, copy, merge, embed, modify,
redistribute, and sell modified and unmodified copies of the Font
Software, subject to the following conditions:

1) Neither the Font Software nor any of its individual components,
in Original or Modified Versions, may be sold by itself.

2) Original or Modified Versions of the Font Software may be bundled,
redistributed and/or sold with any software, provided that each copy
contains the above copyright notice and this license. These can be
included either as stand-alone text files, human-readable headers or
in the appropriate machine-readable metadata fields within text or
binary files as long as those fields can be easily viewed by the user.

3) No Modified Version of the Font Software may use the Reserved Font
Name(s) unless explicit written permission is granted by the corresponding
Copyright Holder. This restriction only applies to the primary font name as
presented to the users.

4) The name(s) of the Copyright Holder(s) or the Author(s) of the Font
Software shall not be used to promote, endorse or advertise any
Modified Version, except to acknowledge the contribution(s) of the
Copyright Holder(s) and the Author(s) or with their explicit written
permission.

5) The Font Software, modified or unmodified, in part or in whole,
must be distributed entirely under this license, and must not be
distributed under any other license. The requirement for fonts to
remain under this license does not apply to any document created
using the Font Software.

TERMINATION
This license becomes null and void if any of the above conditions are
not met.

DISCLAIMER
THE FONT SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO ANY WARRANTIES OF
MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT
OF COPYRIGHT, PATENT, TRADEMARK, OR OTHER RIGHT. IN NO EVENT SHALL THE
COPYRIGHT HOLDER BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
INCLUDING ANY GENERAL, SPECIAL, INDIRECT, INCIDENTAL, OR CONSEQUENTIAL
DAMAGES, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF THE USE OR INABILITY TO USE THE FONT SOFTWARE OR FROM
OTHER DEALINGS IN THE FONT SOFTWARE.
