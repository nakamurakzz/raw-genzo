import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';

// LibRaw（WebAssembly）は scripts/build-libraw.sh でビルドして vendor/libraw/ に置いてある。
// 中の JS は相対 URL で Worker と wasm を読むので、バンドルせずにそのまま /vendor/libraw/ で配る。
// 開発時はミドルウェアで返し、ビルド時は dist/vendor/libraw/ に出力する。
const LIBRAW_DIR = fileURLToPath(new URL('./vendor/libraw/', import.meta.url));
const LIBRAW_FILES = ['index.js', 'worker.js', 'libraw.js', 'libraw.wasm'];
// 配信物に含めるライセンス文（LGPL などの条件を満たすため、サイトからも読めるようにする）
const LIBRAW_LICENSES = ['LICENSE.LibRaw.LGPL', 'LICENSE.LibRaw.CDDL', 'COPYRIGHT.LibRaw', 'LICENSE.libraw-wasm', 'BUILD-INFO.txt'];
const NOTICES = fileURLToPath(new URL('./THIRD_PARTY_NOTICES.md', import.meta.url));
const MIME: Record<string, string> = { '.js': 'text/javascript', '.wasm': 'application/wasm' };
const TEXT = 'text/plain; charset=utf-8';

function vendorLibraw(): Plugin {
  let base = '/';
  return {
    name: 'vendor-libraw',
    configResolved(c) {
      base = c.base;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const path = (req.url ?? '').split('?')[0];
        if (path === `${base}THIRD_PARTY_NOTICES.txt`) {
          res.setHeader('Content-Type', TEXT);
          return res.end(readFileSync(NOTICES));
        }
        const prefix = `${base}vendor/libraw/`;
        if (!path.startsWith(prefix)) return next();
        const name = path.slice(prefix.length);
        if (LIBRAW_FILES.includes(name)) res.setHeader('Content-Type', MIME[extname(name)]);
        else if (LIBRAW_LICENSES.includes(name)) res.setHeader('Content-Type', TEXT);
        else return next();
        res.setHeader('Cache-Control', 'no-cache');
        res.end(readFileSync(join(LIBRAW_DIR, name)));
      });
    },
    generateBundle() {
      for (const name of [...LIBRAW_FILES, ...LIBRAW_LICENSES]) {
        this.emitFile({ type: 'asset', fileName: `vendor/libraw/${name}`, source: readFileSync(join(LIBRAW_DIR, name)) });
      }
      // 日本語を含むので、Content-Type に charset が付かなくても UTF-8 と判定されるよう BOM を付ける
      this.emitFile({ type: 'asset', fileName: 'THIRD_PARTY_NOTICES.txt', source: Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), readFileSync(NOTICES)]) });
    },
  };
}

// public/_headers の「/*」のヘッダを vite preview でも付ける（本番と同じ条件で確認するため）。
// 開発サーバーには付けない（Vite の HMR がインラインの style と WebSocket を使うので CSP と相容れない）。
function productionHeaders(): Record<string, string> {
  const text = readFileSync(fileURLToPath(new URL('./public/_headers', import.meta.url)), 'utf8');
  const block = text.split(/\r?\n\r?\n/).find((b) => b.trimStart().startsWith('/*')) ?? '';
  const headers: Record<string, string> = {};
  for (const line of block.split(/\r?\n/).slice(1)) {
    const m = line.match(/^\s+([\w-]+):\s*(.+)$/);
    if (m) headers[m[1]] = m[2].trim();
  }
  return headers;
}

export default defineConfig({
  plugins: [vendorLibraw()],
  preview: { headers: productionHeaders() },
  worker: { format: 'es' },
  build: { target: 'es2022' },
});
