import type { Host } from './host';

export type LibraryBundle = {
  version: 1;
  palettes: object[];
  variants: { key: string; tree: object }[];
};

export function validateBundle(bundle: LibraryBundle): LibraryBundle;
export function captureLibrary(host: Host): Promise<LibraryBundle>;
