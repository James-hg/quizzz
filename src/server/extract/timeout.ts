import { Timeout } from "./errors";

/**
 * Runs `task` with an AbortSignal that fires after `ms` (or when `parent` aborts). If the task
 * ignores the signal, the caller still gets a Timeout error on time.
 */
export async function withTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  ms: number,
  parent?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onParentAbort = () => controller.abort(parent?.reason);
  if (parent?.aborted) controller.abort(parent.reason);
  else parent?.addEventListener("abort", onParentAbort, { once: true });

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const error = new Timeout();
      controller.abort(error);
      reject(error);
    }, ms);
  });

  try {
    return await Promise.race([task(controller.signal), timeout]);
  } finally {
    clearTimeout(timer);
    parent?.removeEventListener("abort", onParentAbort);
  }
}
