// Must match the name browser/install.sh registers
export const HOST = "io.github.dim0627.shu";

export function lookup(url) {
  if (!/^https?:\/\//.test(url ?? "")) return Promise.resolve({ task: null });
  return chrome.runtime.sendNativeMessage(HOST, { url }).catch((e) => ({
    error: { code: "host", message: `${e.message}. Is the host installed (browser/install.sh)?` },
  }));
}
