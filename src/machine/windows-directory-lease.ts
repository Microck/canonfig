import { win32 } from "node:path";

const readDataAndAttributes = 0x81;
const shareReadWrite = 3;
const openExisting = 3;
const openDirectoryWithoutReparse = 0x02200000;
const attributeTagInfo = 9;
const directoryAttribute = 0x10;
const reparsePointAttribute = 0x400;

const loadWindowsDirectoryCalls = async () => {
  const { default: koffi } = await import("koffi");
  const kernel = koffi.load("kernel32.dll");
  return {
    // Windows paths are UTF-16. Explicitly declare stdcall for 32-bit Node.
    createFile: kernel.func("__stdcall", "CreateFileW", "void *",
      ["str16", "uint32_t", "uint32_t", "void *", "uint32_t", "uint32_t", "void *"]),
    getAttributes: kernel.func("__stdcall", "GetFileInformationByHandleEx", "int32_t",
      ["void *", "int32_t", "void *", "uint32_t"]),
    closeHandle: kernel.func("__stdcall", "CloseHandle", "int32_t", ["void *"]),
    lastError: kernel.func("__stdcall", "GetLastError", "uint32_t", []),
    address: koffi.address,
    pointerBits: koffi.sizeof("void *") * 8,
  };
};

let windowsDirectoryCalls: ReturnType<typeof loadWindowsDirectoryCalls> | undefined;

const windowsFailure = (path: string, code: number) => {
  // Match the Node filesystem message consumed by anchored recovery.
  if (code === 2 || code === 3) return new Error(`ENOENT: Cannot pin Windows entry ${path}`);
  return new Error(`Cannot pin Windows entry ${path}: Win32 error ${code}`);
};

/** Hold every ancestor without delete sharing until the pathname operation ends. */
export const holdWindowsDirectories = async (
  directories: ReadonlyArray<string>,
  createDirectory?: (path: string) => Promise<void>,
  allowLeafFile = false,
) => {
  const native = await (windowsDirectoryCalls ??= loadWindowsDirectoryCalls());
  const held: Array<unknown> = [];
  const close = async () => {
    while (held.length > 0) native.closeHandle(held.pop());
  };
  const open = (path: string) => {
    // The data access makes this handle participate in sharing checks.
    // It permits ordinary reads and child publication while refusing DELETE.
    const handle: unknown = native.createFile(win32.toNamespacedPath(path), readDataAndAttributes,
      shareReadWrite, null, openExisting, openDirectoryWithoutReparse, null);
    const code = Number(native.lastError());
    return handle === null || BigInt.asIntN(native.pointerBits, native.address(handle)) === -1n
      ? { kind: "failure", code } as const
      : { kind: "opened", handle } as const;
  };

  try {
    // FILE_ATTRIBUTE_TAG_INFO has two 32-bit fields. Only Attributes is needed.
    const metadata = Buffer.alloc(8);
    for (const [index, path] of directories.entries()) {
      let result = open(path);
      if (result.kind === "failure" && (result.code === 2 || result.code === 3)
        && index > 0 && createDirectory !== undefined) {
        await createDirectory(path);
        result = open(path);
      }
      if (result.kind === "failure") throw windowsFailure(path, result.code);
      held.push(result.handle);
      if (native.getAttributes(result.handle, attributeTagInfo, metadata, metadata.length) === 0) {
        throw windowsFailure(path, Number(native.lastError()));
      }
      const attributes = metadata.readUInt32LE(0);
      const requireDirectory = !allowLeafFile || index !== directories.length - 1;
      if ((requireDirectory && (attributes & directoryAttribute) === 0)
        || (attributes & reparsePointAttribute) !== 0) {
        throw new Error(`A real directory is required under the anchor: ${path}`);
      }
    }
  } catch (cause) {
    await close();
    throw cause;
  }

  return {
    verify: async () => {
      if (held.length !== directories.length) throw new Error("Windows released the held directory anchor");
    },
    close,
  };
};
