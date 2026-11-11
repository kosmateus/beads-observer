export type BrowserOpenResult =
  | { opened: true; url: string }
  | { opened: false; url: string; message: string };

export type BrowserOpener = (url: string) => Promise<BrowserOpenResult>;
