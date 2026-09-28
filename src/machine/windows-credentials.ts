import { createHash } from "node:crypto";
import { release } from "node:os";
import { win32 } from "node:path";
const build = Number(release().split(".")[2]);
const windows10Arm64 = process.platform === "win32" && process.arch === "arm64"
  && build >= 19000 && build < 22000;
// The first PowerShell Core call compiles the native helper once. Under QEMU
// that cold compile can outlast an ordinary Windows credential operation.
export const windowsCredentialTimeoutMilliseconds = windows10Arm64 ? 600_000 : 30_000;

export const windowsPowerShellExecutable = (
  environment: NodeJS.ProcessEnv = process.env,
): string => {
  if (environment.CANONFIG_POWERSHELL !== undefined) return environment.CANONFIG_POWERSHELL;
  if (windows10Arm64) {
    return win32.join(environment.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe");
  }
  return win32.join(
    environment.SystemRoot ?? "C:\\Windows",
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
};

/*
 * Fixed PowerShell programs for the Windows native vault. Values arrive over
 * UTF-8 stdin, never in the script, environment, or process arguments.
 * Desktop PowerShell keeps the WinRT vault used by existing installations;
 * PowerShell Core uses the native generic Credential Manager API.
 */
const winCredSource = String.raw`
using System;
using System.ComponentModel;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;

public static class CanonfigWinCred
{
    private const uint Generic = 1;
    private const uint LocalMachine = 2;
    private const int ChunkSize = 2560;
    private const int MaximumLength = 1024 * 1024;
    private const int NotFound = 1168;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags;
        public uint Type;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetName;
        [MarshalAs(UnmanagedType.LPWStr)] public string Comment;
        public long LastWritten;
        public uint CredentialBlobSize;
        public IntPtr CredentialBlob;
        public uint Persist;
        public uint AttributeCount;
        public IntPtr Attributes;
        [MarshalAs(UnmanagedType.LPWStr)] public string TargetAlias;
        [MarshalAs(UnmanagedType.LPWStr)] public string UserName;
    }

    [DllImport("advapi32.dll", EntryPoint = "CredWriteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredReadW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr credential);

    [DllImport("advapi32.dll", EntryPoint = "CredDeleteW", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);

    [DllImport("advapi32.dll", EntryPoint = "CredFree")]
    private static extern void CredFree(IntPtr credential);

    private sealed class Header
    {
        public string Id;
        public int Length;
        public string Digest;
        public int Parts;
    }

    private static string PartName(string target, string id, int index)
    {
        return target + ".canonfig.v1." + id + "." + index.ToString(CultureInfo.InvariantCulture);
    }

    private static byte[] ReadBytes(string target, bool allowMissing)
    {
        IntPtr pointer;
        if (!CredRead(target, Generic, 0, out pointer))
        {
            int error = Marshal.GetLastWin32Error();
            if (allowMissing && error == NotFound) return null;
            throw new Win32Exception(error);
        }
        Credential credential = new Credential();
        try
        {
            credential = Marshal.PtrToStructure<Credential>(pointer);
            if (credential.CredentialBlobSize > ChunkSize)
                throw new InvalidOperationException("Credential blob exceeds the native size limit");
            byte[] bytes = new byte[credential.CredentialBlobSize];
            if (bytes.Length != 0) Marshal.Copy(credential.CredentialBlob, bytes, 0, bytes.Length);
            return bytes;
        }
        finally
        {
            if (credential.CredentialBlobSize != 0)
                Marshal.Copy(new byte[credential.CredentialBlobSize], 0, credential.CredentialBlob, (int)credential.CredentialBlobSize);
            CredFree(pointer);
        }
    }

    private static void WriteBytes(string target, byte[] bytes)
    {
        GCHandle pinned = GCHandle.Alloc(bytes, GCHandleType.Pinned);
        try
        {
            Credential credential = new Credential {
                Type = Generic, TargetName = target, UserName = "canonfig",
                CredentialBlobSize = (uint)bytes.Length,
                CredentialBlob = bytes.Length == 0 ? IntPtr.Zero : pinned.AddrOfPinnedObject(),
                Persist = LocalMachine
            };
            if (!CredWrite(ref credential, 0)) throw new Win32Exception(Marshal.GetLastWin32Error());
        }
        finally { pinned.Free(); }
    }

    private static Header ReadHeader(string target, bool allowMissing)
    {
        byte[] bytes = ReadBytes(target, allowMissing);
        if (bytes == null) return null;
        try
        {
            string[] fields = Encoding.ASCII.GetString(bytes).Split(':');
            Guid id;
            int length, parts;
            if (fields.Length != 6 || fields[0] != "canonfig-wincred" || fields[1] != "1"
                || !Guid.TryParseExact(fields[2], "N", out id)
                || !int.TryParse(fields[3], NumberStyles.None, CultureInfo.InvariantCulture, out length)
                || !int.TryParse(fields[5], NumberStyles.None, CultureInfo.InvariantCulture, out parts)
                || length < 0 || length > MaximumLength
                || parts != (length + ChunkSize - 1) / ChunkSize
                || fields[4].Length != 64)
                throw new InvalidOperationException("Credential root is invalid");
            foreach (char digit in fields[4])
                if (!Uri.IsHexDigit(digit)) throw new InvalidOperationException("Credential digest is invalid");
            return new Header { Id = fields[2], Length = length, Digest = fields[4], Parts = parts };
        }
        finally { Array.Clear(bytes, 0, bytes.Length); }
    }

    private static void Delete(string target, bool allowMissing)
    {
        if (!CredDelete(target, Generic, 0))
        {
            int error = Marshal.GetLastWin32Error();
            if (!allowMissing || error != NotFound) throw new Win32Exception(error);
        }
    }

    private static void CleanupParts(string target, string id, int count)
    {
        for (int i = 0; i < count; i++)
        {
            try { Delete(PartName(target, id, i), true); }
            catch (Win32Exception) { /* A failed cleanup must not mask the write or delete error. */ }
        }
    }

    public static void Store(string target, string value)
    {
        Header previous = ReadHeader(target, true);
        byte[] bytes = new UTF8Encoding(false, true).GetBytes(value);
        if (bytes.Length > MaximumLength)
        {
            Array.Clear(bytes, 0, bytes.Length);
            throw new InvalidOperationException("Credential exceeds the size limit");
        }
        string id = Guid.NewGuid().ToString("N");
        int count = (bytes.Length + ChunkSize - 1) / ChunkSize;
        int written = 0;
        bool committed = false;
        try
        {
            for (int i = 0; i < count; i++)
            {
                int size = Math.Min(ChunkSize, bytes.Length - i * ChunkSize);
                byte[] part = new byte[size];
                try
                {
                    Buffer.BlockCopy(bytes, i * ChunkSize, part, 0, size);
                    WriteBytes(PartName(target, id, i), part);
                    written++;
                }
                finally { Array.Clear(part, 0, part.Length); }
            }
            byte[] digest;
            using (SHA256 sha = SHA256.Create()) digest = sha.ComputeHash(bytes);
            string root = "canonfig-wincred:1:" + id + ":"
                + bytes.Length.ToString(CultureInfo.InvariantCulture) + ":"
                + Convert.ToHexString(digest) + ":" + count.ToString(CultureInfo.InvariantCulture);
            Array.Clear(digest, 0, digest.Length);
            byte[] metadata = Encoding.ASCII.GetBytes(root);
            try { WriteBytes(target, metadata); }
            finally { Array.Clear(metadata, 0, metadata.Length); }
            committed = true;
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
            if (!committed) CleanupParts(target, id, written);
        }
        if (previous != null) CleanupParts(target, previous.Id, previous.Parts);
    }

    public static string Load(string target)
    {
        // An overwrite publishes the new root before deleting old parts. A
        // reader that observed the old root may have to retry that race.
        for (int attempt = 0; attempt < 3; attempt++)
        {
            Header header = ReadHeader(target, false);
            byte[] bytes = new byte[header.Length];
            try
            {
                for (int i = 0; i < header.Parts; i++)
                {
                    byte[] part = ReadBytes(PartName(target, header.Id, i), false);
                    try
                    {
                        int size = Math.Min(ChunkSize, bytes.Length - i * ChunkSize);
                        if (part.Length != size) throw new InvalidOperationException("Credential part is invalid");
                        Buffer.BlockCopy(part, 0, bytes, i * ChunkSize, size);
                    }
                    finally { Array.Clear(part, 0, part.Length); }
                }
                byte[] digest;
                using (SHA256 sha = SHA256.Create()) digest = sha.ComputeHash(bytes);
                try
                {
                    if (!string.Equals(Convert.ToHexString(digest), header.Digest, StringComparison.OrdinalIgnoreCase))
                        throw new InvalidOperationException("Credential digest does not match");
                }
                finally { Array.Clear(digest, 0, digest.Length); }
                return new UTF8Encoding(false, true).GetString(bytes);
            }
            catch
            {
                if (attempt == 2 || ReadHeader(target, false).Id == header.Id) throw;
            }
            finally { Array.Clear(bytes, 0, bytes.Length); }
        }
        throw new InvalidOperationException("Credential changed during read");
    }

    public static void Remove(string target)
    {
        Header header = ReadHeader(target, false);
        Delete(target, false);
        Win32Exception failure = null;
        for (int i = 0; i < header.Parts; i++)
        {
            try { Delete(PartName(target, header.Id, i), true); }
            catch (Win32Exception error) { if (failure == null) failure = error; }
        }
        if (failure != null) throw new InvalidOperationException("Could not remove every credential part", failure);
    }
}
`;
const winCredAssemblyName = `CanonfigWinCred-${createHash("sha256").update(winCredSource).digest("hex").slice(0, 16)}.dll`;

export const windowsCredentialScript = (
  operation: "store" | "load" | "remove",
): string => {
  const prelude = [
    "$ErrorActionPreference='Stop'",
    "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
  ];
  const native = [
    "$nativeData=if($env:LOCALAPPDATA){$env:LOCALAPPDATA}else{[Environment]::GetFolderPath('LocalApplicationData')}",
    "if(-not $nativeData){throw 'Windows local application data directory is unavailable'}",
    "$assemblyRoot=Join-Path $nativeData 'canonfig\\native'",
    `$assembly=Join-Path $assemblyRoot '${winCredAssemblyName}'`,
    "if(-not (Test-Path -LiteralPath $assembly)){",
    "$null=New-Item -ItemType Directory -Force -Path $assemblyRoot",
    "$staging=Join-Path $assemblyRoot ([IO.Path]::GetRandomFileName()+'.dll')",
    `$source=@'\n${winCredSource}\n'@`,
    "Add-Type -TypeDefinition $source -OutputAssembly $staging",
    "try{Move-Item -LiteralPath $staging -Destination $assembly}",
    "catch{Remove-Item -LiteralPath $staging -Force;if(-not (Test-Path -LiteralPath $assembly)){throw}}",
    "}",
    "$null=[Reflection.Assembly]::LoadFrom($assembly)",
    operation === "store"
      ? "[CanonfigWinCred]::Store($env:CANONFIG_TARGET,[Console]::In.ReadToEnd())"
      : operation === "load"
      ? "[Console]::Out.Write([CanonfigWinCred]::Load($env:CANONFIG_TARGET))"
      : "[CanonfigWinCred]::Remove($env:CANONFIG_TARGET)",
  ].join("\n");
  const desktop = [
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "$vault=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()",
    ...(operation === "store"
      ? [
        "$secret=[Console]::In.ReadToEnd()",
        "$credential=[Windows.Security.Credentials.PasswordCredential,Windows.Security.Credentials,ContentType=WindowsRuntime]::new($env:CANONFIG_TARGET,'canonfig',$secret)",
        "$vault.Add($credential)",
      ]
      : operation === "load"
      ? [
        "$credential=$vault.Retrieve($env:CANONFIG_TARGET,'canonfig')",
        "$credential.RetrievePassword()",
        "[Console]::Out.Write($credential.Password)",
      ]
      : [
        "$credential=$vault.Retrieve($env:CANONFIG_TARGET,'canonfig')",
        "$vault.Remove($credential)",
      ]),
  ].join(";");
  return [...prelude, `if ($PSVersionTable.PSEdition -eq 'Core') {\n${native}\n} else {\n${desktop}\n}`].join(";");
};
