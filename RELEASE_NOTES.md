# Canonfig v3.2.1

Canonfig 3.2.1 requires Node.js 24 or newer.

## Bug Fixes

- Pin Canonfig's shared Effect runtime package to the same release candidate as
  the CLI's direct Effect dependencies. Clean npm installs can no longer resolve
  incompatible Effect copies that make `canonfig doctor` fail during runtime
  layer initialization.

Canonfig 3.2.0 is deprecated. Upgrade to 3.2.1 before running synchronization or
diagnostics.

Full changelog: https://github.com/Microck/canonfig/compare/v3.2.0...v3.2.1
