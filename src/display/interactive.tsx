import { CliRenderEvents, createCliRenderer } from '@opentui/core';
import { createRoot } from '@opentui/react';

import { RunView, ViewBoundary, type ViewProps, type ViewSnapshot } from './components/index.ts';

export interface InteractiveSession {
  update(snapshot: ViewSnapshot): void;
  wait(): Promise<void>;
  dispose(): Promise<void>;
}

export interface InteractiveRuntime {
  createRenderer: typeof createCliRenderer;
  createRoot: typeof createRoot;
}

export async function createInteractive(
  snapshot: ViewSnapshot,
  options: ViewProps['options'],
  onStop: () => void,
  signal: AbortSignal,
  runtime: InteractiveRuntime = { createRenderer: createCliRenderer, createRoot },
): Promise<InteractiveSession> {
  const renderer = await runtime.createRenderer({
    exitOnCtrlC: false,
    exitSignals: [],
    useMouse: false,
    screenMode: 'alternate-screen',
    consoleMode: 'disabled',
    openConsoleOnError: false,
  });

  let setupRoot: ReturnType<typeof createRoot> | undefined;
  let abortListener: (() => void) | undefined;
  try {
    const root = runtime.createRoot(renderer);
    setupRoot = root;

    let disposed = false;
    let finished = snapshot.finished;
    let failure: unknown;
    let resolveExit!: () => void;
    const exited = new Promise<void>((resolve) => {
      resolveExit = resolve;
    });

    const exit = (): void => {
      if (!finished) onStop();
      resolveExit();
    };
    const fail = (error: unknown): void => {
      failure = error;
      exit();
    };

    renderer.on(CliRenderEvents.RENDER_ERROR, fail);
    renderer.on(CliRenderEvents.HANDLER_ERROR, (event) => fail(event.error));
    renderer.closed.catch(fail);

    signal.addEventListener('abort', resolveExit, { once: true });
    abortListener = resolveExit;
    if (signal.aborted) resolveExit();

    function update(next: ViewSnapshot): void {
      finished = next.finished;
      root.render(
        <ViewBoundary onFailure={fail}>
          <RunView snapshot={next} options={options} onExit={exit} onFailure={fail} />
        </ViewBoundary>,
      );
    }

    update(snapshot);
    return {
      update,

      async wait(): Promise<void> {
        await exited;
        if (failure !== undefined) throw failure;
      },

      async dispose(): Promise<void> {
        if (disposed) {
          await renderer.closed;
          return;
        }
        disposed = true;
        signal.removeEventListener('abort', resolveExit);
        try {
          root.unmount();
        } finally {
          renderer.destroy();
          await renderer.closed;
        }
      },
    };
  } catch (error) {
    if (abortListener) signal.removeEventListener('abort', abortListener);
    try {
      setupRoot?.unmount();
    } finally {
      renderer.destroy();
      await renderer.closed;
    }
    throw error;
  }
}
