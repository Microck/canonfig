import { constants as filesystemConstants } from "node:fs";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";

/**
 * A directory reached from an anchor through real directories only, never a
 * link, for reads and writes that must not leave the anchor
 * (`ReadFileInput.anchor`, `AtomicWriteInput.anchor`).
 *
 * On Linux every component is opened relative to the previous one's
 * descriptor (`/proc/self/fd/<n>/<name>` with O_NOFOLLOW), and `base` names
 * the last opened directory itself: an ancestor swapped for a link after the
 * walk cannot redirect anything done through `base`. Node has no
 * descriptor-relative open elsewhere, so on macOS and Windows every component
 * is checked with lstat and its identity recorded, and `verify` walks again
 * and refuses any change. That narrows a swap to a race between two walks
 * rather than closing it; callers verify after the operation they guard.
 */
export interface AnchoredDirectory {
  /** Join an entry name to this to reach the entry inside the directory. */
  readonly base: string;
  /** Throw when a component changed since the directory was opened. */
  readonly verify: () => Promise<void>;
  readonly close: () => Promise<void>;
}

type Identity = { readonly dev: bigint; readonly ino: bigint };

/** Two lstat or fstat results name the same filesystem object. */
export const sameIdentity = (left: Identity, right: Identity): boolean =>
  left.dev === right.dev && left.ino === right.ino;

const componentsBelow = (anchor: string, directory: string): ReadonlyArray<string> => {
  const remainder = relative(anchor, directory);
  if (remainder === ".." || remainder.startsWith(`..${sep}`) || isAbsolute(remainder)) {
    throw new Error(`${directory} is not below ${anchor}`);
  }
  return remainder === "" ? [] : remainder.split(sep);
};

const realDirectory = async (path: string): Promise<Identity> => {
  const status = await lstat(path, { bigint: true });
  if (status.isSymbolicLink() || !status.isDirectory()) {
    throw new Error(`${path} is not a directory; links are refused below the anchor`);
  }
  return status;
};

const descriptorDirectory = async (anchor: string, components: ReadonlyArray<string>): Promise<AnchoredDirectory> => {
  const flags = filesystemConstants.O_RDONLY | filesystemConstants.O_DIRECTORY | filesystemConstants.O_NOFOLLOW;
  const handles: Array<FileHandle> = [];
  const close = async () => {
    for (const handle of handles.reverse()) await handle.close().catch(() => undefined);
  };
  try {
    handles.push(await open(anchor, flags));
    for (const component of components) {
      handles.push(await open(join(`/proc/self/fd/${handles.at(-1)!.fd}`, component), flags));
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { base: `/proc/self/fd/${handles.at(-1)!.fd}`, verify: async () => undefined, close };
};

const walkedDirectory = async (anchor: string, components: ReadonlyArray<string>): Promise<AnchoredDirectory> => {
  const paths = components.reduce<Array<string>>((walked, component) => [...walked, join(walked.at(-1)!, component)], [anchor]);
  const identities: Array<Identity> = [];
  for (const path of paths) identities.push(await realDirectory(path));
  return {
    base: paths.at(-1)!,
    verify: async () => {
      for (const [index, path] of paths.entries()) {
        if (!sameIdentity(await realDirectory(path), identities[index]!)) throw new Error(`${path} changed while Canonfig used it`);
      }
    },
    close: async () => undefined,
  };
};

/** Open `directory`, which must lie below or be `anchor`, refusing a link anywhere from `anchor` down. */
export const openAnchoredDirectory = (anchor: string, directory: string): Promise<AnchoredDirectory> => {
  const components = componentsBelow(anchor, directory);
  return process.platform === "linux" ? descriptorDirectory(anchor, components) : walkedDirectory(anchor, components);
};
