// LibRaw を動かす Worker。libraw-wasm v1.6.0 の worker.js（ISC）を元に、
// C++ 例外を読めるメッセージに変換する処理だけを足したもの。
import LibRawModule from './libraw.js';

let module;
let raw;
const ready = (async () => {
  module = await LibRawModule();
  raw = new module.LibRaw();
})();

function isTypedArray(obj) {
  return ArrayBuffer.isView(obj) && !(obj instanceof DataView);
}

function errorMessage(err) {
  if (err instanceof Error) return err.message;
  // C++ の例外は wasm 内のポインタ（数値）として届く
  try {
    const [type, message] = module.getExceptionMessage(err);
    module.decrementExceptionRefcount?.(err);
    return message || type;
  } catch {
    return String(err);
  }
}

self.onmessage = async (event) => {
  const { id, fn, args } = event.data;
  try {
    await ready;
    const out = raw[fn](...args);
    const transferList = [];
    for (const key in out) {
      const value = out[key];
      if (isTypedArray(value)) transferList.push(value.buffer);
    }
    self.postMessage({ id, out }, transferList);
  } catch (err) {
    self.postMessage({ id, error: errorMessage(err) });
  }
};
