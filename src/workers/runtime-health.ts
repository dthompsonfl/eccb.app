export interface WorkerRuntimeState {
  email: boolean;
  scheduler: boolean;
  smartUpload: boolean;
  ocr: boolean;
  sockets: boolean;
  socketsRequired: boolean;
}

export interface WorkerRuntimeHealth {
  healthy: boolean;
  ready: boolean;
}

export function evaluateWorkerRuntimeHealth(state: WorkerRuntimeState): WorkerRuntimeHealth {
  const socketsReady = !state.socketsRequired || state.sockets;
  const requiredWorkersReady =
    state.email && state.scheduler && state.smartUpload && state.ocr && socketsReady;

  return {
    healthy: requiredWorkersReady,
    ready: requiredWorkersReady,
  };
}
