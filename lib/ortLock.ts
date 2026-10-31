// onnxruntime-web models share one wasm heap and corrupt it if two runs overlap.
// Every session.run() in the app goes through this lock, so runs take turns.
let tail: Promise<unknown> = Promise.resolve();

export function withOrt<T>(fn: () => Promise<T>): Promise<T> {
  const next = tail.then(fn, fn);
  tail = next.catch(() => {});
  return next;
}
