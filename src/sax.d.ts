declare module 'sax' {
  interface Attribute {
    name: string;
    uri: string;
    local: string;
    value: string;
  }
  interface Tag {
    name: string;
    local: string;
    uri: string;
    attributes: Record<string, Attribute>;
  }
  interface Parser {
    readonly position: number;
    readonly startTagPosition: number;
    onerror(error: Error): void;
    onattribute(attribute: Attribute): void;
    onopentag(tag: Tag): void;
    onclosetag(): void;
    ondoctype(): void;
    ontext(text: string): void;
    oncdata(text: string): void;
    write(text: string): Parser;
    close(): Parser;
  }
  export function parser(strict: true, options: { xmlns: true; strictEntities: true }): Parser;
}
