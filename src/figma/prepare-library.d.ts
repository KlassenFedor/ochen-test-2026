import type { Host } from './host';
import type { LibraryBundle } from './library-bundle.js';

export function createPreparation(
  host: Host & { commitUndo(): void }, status: (text: string) => void
): {
  run(mode: 'setup' | 'verify'): Promise<{ text: string; report?: object }>;
  install(bundle: LibraryBundle): Promise<void>;
  cancel(): void;
};
