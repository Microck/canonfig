# Windows native credential execution

Both enrollment's MachineState path and shared-secret transfer use the same
fixed PowerShell program. It explicitly activates both Windows Runtime types it
needs, the vault and the credential, and sets UTF-8 input and output.
Secret values travel through standard input, not command arguments or environment
variables. Names are hashed into Canonfig-owned native credential references.

The native regression contract exercises both paths with disposable ASCII,
Unicode, and quoted/multiline values, checks exact readback, removes its own
items, and checks that removed values cannot be loaded. It runs in the existing
Windows native secret-store CI step; non-Windows runs skip these native cases.
No fixture reads or modifies an operator's pre-existing credentials.

Provider executable presence still does not prove access in a particular SSH,
login, or scheduler session. This change repairs invocation and byte round trips;
it does not claim to solve credential readiness diagnostics, logged-out access,
or the lifetime of an operator's login session.
