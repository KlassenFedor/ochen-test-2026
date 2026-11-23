import type { Dimensions, Transform } from '../layout';
import type { RGB } from '../palette';

// Boundary shared by the adapter and the in-memory host used by tests.
export type SolidPaint = {
  readonly type: 'SOLID';
  readonly color: RGB;
  readonly opacity?: number;
  readonly visible?: boolean;
  readonly blendMode?: string;
  readonly boundVariables?: { readonly color?: { readonly id: string } };
};
export type Paint = SolidPaint | { readonly type: Exclude<
  'GRADIENT_LINEAR' | 'GRADIENT_RADIAL' | 'GRADIENT_ANGULAR' | 'GRADIENT_DIAMOND'
  | 'IMAGE' | 'VIDEO' | 'PATTERN' | 'SHADER', 'SOLID'
> };
export type PaintList = readonly Paint[] | symbol;

export interface Node {
  readonly id: string;
  readonly type: string;
  readonly removed: boolean;
  readonly parent: Node | null;
  name: string;
  readonly children?: readonly Node[];
  fills?: PaintList;
  strokes?: PaintList;
  getPluginData(key: string): string;
  setPluginData(key: string, value: string): void;
  remove(): void;
}

export interface Drawable extends Node, Dimensions {
  x: number;
  y: number;
  visible: boolean;
  locked: boolean;
  relativeTransform: Transform;
}

interface Container extends Drawable {
  readonly children: readonly Drawable[];
  appendChild(node: Drawable): void;
  insertChild(index: number, node: Drawable): void;
}

export interface Page extends Node {
  readonly type: 'PAGE';
  readonly children: readonly Drawable[];
  selection: readonly Drawable[];
  loadAsync(): Promise<void>;
}

export interface Section extends Container {
  readonly type: 'SECTION';
  resizeWithoutConstraints(width: number, height: number): void;
}

export interface Frame extends Container {
  readonly type: 'FRAME';
  fills: PaintList;
  clipsContent: boolean;
  resizeWithoutConstraints(width: number, height: number): void;
  exportAsync(settings: {format: 'SVG_STRING'; svgIdAttribute: boolean; svgSimplifyStroke: boolean}): Promise<string>;
}

export interface Component extends Container {
  readonly type: 'COMPONENT';
  readonly variantProperties?: Record<string, string> | null;
  createInstance(): Instance;
}

export interface Instance extends Drawable {
  readonly type: 'INSTANCE';
  getMainComponentAsync(): Promise<Component | null>;
  rescale(scale: number): void;
}

export interface Variable {
  readonly id: string;
  readonly name: string;
  readonly variableCollectionId: string;
  readonly valuesByMode: Readonly<Record<string, unknown>>;
}

export interface Host {
  readonly root: { readonly children: readonly Page[] };
  readonly currentPage: Page;
  skipInvisibleInstanceChildren: boolean;
  setCurrentPageAsync(page: Page): Promise<void>;
  createFrame(): Frame;
  readonly variables: {
    getLocalVariableCollectionsAsync(): Promise<readonly {id: string; name: string; defaultModeId: string}[]>;
    getLocalVariablesAsync(type: 'COLOR'): Promise<readonly Variable[]>;
    setBoundVariableForPaint(paint: SolidPaint, field: 'color', variable: Variable | null): SolidPaint;
  };
  readonly viewport: { scrollAndZoomIntoView(nodes: readonly Drawable[]): void };
}
