/**
 * Fixed PowerShell programs for the Windows native vault. Values are delivered
 * over UTF-8 stdin, never interpolated into source or exposed in process argv.
 * Explicit WinRT activation also works in Windows PowerShell/OpenSSH sessions.
 */
export const windowsCredentialScript = (
  operation: "store" | "load" | "remove",
): string => {
  const prelude = [
    "$ErrorActionPreference='Stop'",
    "[Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false)",
    "Add-Type -AssemblyName System.Runtime.WindowsRuntime",
    "$vault=[Windows.Security.Credentials.PasswordVault,Windows.Security.Credentials,ContentType=WindowsRuntime]::new()",
  ];
  switch (operation) {
    case "store":
      return [...prelude,
        "$secret=[Console]::In.ReadToEnd()",
        "$credential=New-Object -TypeName Windows.Security.Credentials.PasswordCredential -ArgumentList @($env:CANONFIG_TARGET,'canonfig',$secret)",
        "$vault.Add($credential)",
      ].join(";");
    case "load":
      return [...prelude,
        "$credential=$vault.Retrieve($env:CANONFIG_TARGET,'canonfig')",
        "$credential.RetrievePassword()",
        "[Console]::Out.Write($credential.Password)",
      ].join(";");
    case "remove":
      return [...prelude,
        "$credential=$vault.Retrieve($env:CANONFIG_TARGET,'canonfig')",
        "$vault.Remove($credential)",
      ].join(";");
  }
};
