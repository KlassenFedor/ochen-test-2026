declare module 'pako/lib/inflate.js' {
  export function inflate(data: Uint8Array, options: { to: 'string' }): string;
}
