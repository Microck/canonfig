# Windows native credential execution

MachineState enrollment and shared-secret transfer use the native Windows
Credential Manager generic credential API through a fixed PowerShell helper.
Secret values enter over UTF-8 standard input. Credential names are hashed
into Canonfig-owned targets.

The root record names the active generation and its expected length and
digest. A write publishes new chunks before switching the root to that
generation. A per-user, per-credential mutex serializes reads, writes and
removals across Windows login sessions. Readers keep their generation
protected until they finish verifying and assembling it. Replacement and
removal reclaim unreferenced chunks, including chunks left behind by an
interrupted writer.

Native regression tests cover concurrent rotation and cleanup of interrupted
generations. A separate contract exercises both paths with disposable ASCII,
Unicode, and quoted/multiline values, checks exact readback, removes its own
items, and checks that removed values cannot be loaded. It runs in the existing
Windows native secret-store CI step; non-Windows runs skip these native cases.
No fixture reads or modifies an operator's pre-existing credentials.

Provider executable presence does not prove access in a particular SSH,
login, or scheduler session. This program covers invocation and byte round trips;
it does not claim to solve credential readiness diagnostics, logged-out access,
or the lifetime of an operator's login session.
