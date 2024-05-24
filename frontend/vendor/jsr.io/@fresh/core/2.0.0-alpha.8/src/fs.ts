import { walk, type WalkEntry, type WalkOptions } from "jsr:/@std/fs@^0.221.0/walk";

export interface FreshFile {
  size: number;
  readable: ReadableStream<Uint8Array>;
}

export interface FsAdapter {
  walk(
    root: string | URL,
    options?: WalkOptions,
  ): AsyncIterableIterator<WalkEntry>;
  isDirectory(path: string | URL): Promise<boolean>;
  mkdirp(dir: string): Promise<void>;
  readFile(path: string | URL): Promise<Uint8Array>;
}

export const fsAdapter: FsAdapter = {
  walk,
  async isDirectory(path) {
    try {
      const stat = await Deno.stat(path);
      return stat.isDirectory;
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return false;
      throw err;
    }
  },
  async mkdirp(dir: string) {
    try {
      await Deno.mkdir(dir, { recursive: true });
    } catch (err) {
      if (!(err instanceof Deno.errors.AlreadyExists)) {
        throw err;
      }
    }
  },
  readFile: Deno.readFile,
};
