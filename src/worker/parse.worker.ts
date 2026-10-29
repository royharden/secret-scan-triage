import { failureResponse, processImport } from './importReport.ts';
import type { ImportRequest, ImportResponse } from './protocol.ts';

// Minimal structural worker interface avoids mixing lib.dom and lib.webworker declarations in the shared tsconfig.
const scope = globalThis as unknown as {
  onmessage: ((event: MessageEvent<ImportRequest>) => void) | null;
  postMessage: (message: ImportResponse) => void;
  close: () => void;
};
scope.onmessage = (event) => {
  void processImport(event.data).then(
    (result) => { scope.postMessage(result); scope.close(); },
    (error: unknown) => { scope.postMessage(failureResponse(error)); scope.close(); },
  );
};
