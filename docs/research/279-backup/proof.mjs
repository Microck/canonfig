import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { DatabaseSync } from 'node:sqlite';

// Run only inside the task-owned Raft workspace, as its disposable proof user.
assert.equal(process.env.CANONFIG_BACKUP_PROOF, 'disposable-raft');
assert.notEqual(process.getuid(), 0);
const main = resolve('dist/runtime/main.js');
assert(existsSync(main));
const root = mkdtempSync(join(tmpdir(), 'canonfig-279-proof-'));
const children = [];
const evidence = [];
const envFor = home => ({ ...process.env, HOME: home, USERPROFILE: home,
  XDG_CACHE_HOME: join(home, '.cache'), XDG_CONFIG_HOME: join(home, '.config'),
  CANONFIG_LOCAL_CREDENTIAL_ROOT: join(home, 'credentials'), NODE_NO_WARNINGS: '1',
  GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(root, 'gitconfig') });
const run = (command, args, env, input) => {
  const result = spawnSync(command, args, { env, input, encoding: 'utf8', timeout: 180_000 });
  if (result.error || result.status !== 0) throw new Error(`${command} ${args.slice(0, 2).join(' ')} failed: ${result.error?.message ?? result.stderr}`);
  return result.stdout;
};
const cli = (env, args, input) => {
  const result = spawnSync(process.execPath, [main, ...args, '--json'], { env, input, encoding: 'utf8', timeout: 180_000 });
  let body;
  try { body = JSON.parse(result.status === 0 ? result.stdout : result.stderr); } catch { throw new Error(`CLI ${args.slice(0, 2).join(' ')} returned no JSON: ${result.stderr}`); }
  if (result.status !== 0) throw new Error(`CLI ${args.slice(0, 2).join(' ')} exited ${result.status}: ${JSON.stringify(body)}`);
  return body.data;
};
const fixture = name => {
  const home = join(root, name);
  const folder = join(home, '.canonfig');
  mkdirSync(folder, {recursive: true, mode: 0o700});
  writeFileSync(join(folder, 'canonfig.jsonc'), '{"version":1,"harnesses":[]}\n');
  writeFileSync(join(folder, 'AGENTS.md'), '# Disposable backup proof\nPreserve these exact bytes.\n');
  return {home, folder, env: envFor(home)};
};
const policy = destination => ({destination, folder: true, harnesses: {mode: 'none', targets: []},
  compression: 'balanced', sourceIdentity: false, sharedSecrets: false, includeCredentials: false,
  include: [], exclude: [], retention: {last: 2, daily: 0, weekly: 0}, maximumBytes: 10485760, maximumFiles: 1000});
const configure = (env, name, value, consent = false) => {
  const path = join(root, `${name}.json`);
  writeFileSync(path, JSON.stringify(value));
  return cli(env, ['backup', 'configure', name, '--policy', path, ...(consent ? ['--allow-credentials'] : [])]);
};
const restoredEqual = (source, output) => {
  for (const name of ['canonfig.jsonc', 'AGENTS.md']) assert.deepEqual(readFileSync(join(output, '.canonfig', name)), readFileSync(join(source.folder, name)));
};
const launch = (command, args, env, input) => {
  const child = spawn(command, args, {env, stdio: [input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe']});
  children.push(child);
  if (input !== undefined) child.stdin.end(input);
  return child;
};
const ready = async (url, child) => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error('Fixture service exited before readiness');
    try { if ((await fetch(url)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw new Error('Fixture service readiness timed out');
};

const nativeEnvFor = home => {
  const env = envFor(home);
  delete env.CANONFIG_LOCAL_CREDENTIAL_ROOT;
  return env;
};
const stop = async child => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const stopped = once(child, 'exit'); child.kill(); await stopped;
};
const sourceServer = async env => {
  const server = launch(process.execPath, [main, 'source', 'serve', '--host', '127.0.0.1', '--port', '4319', '--json'], env);
  server.stderr.resume();
  const endpoint = await new Promise((resolve, reject) => {
    let text = '';
    const timeout = setTimeout(() => reject(new Error('Source startup timed out')), 60_000);
    server.once('exit', code => { clearTimeout(timeout); reject(new Error(`Source exited ${code}`)); });
    server.stdout.on('data', chunk => {
      text += chunk;
      if (!text.includes('\n')) return;
      clearTimeout(timeout);
      server.stdout.removeAllListeners('data'); server.stdout.resume();
      resolve(JSON.parse(text.slice(0, text.indexOf('\n'))).data.endpoint);
    });
  });
  return {server, endpoint};
};
const credential = (reference, env) => {
  const match = /^secret-service:([^:]+)(?::([0-9]+))?$/u.exec(reference);
  assert(match, 'Recovery did not use a native reference');
  return Array.from({length: Number(match[2] ?? 1)}, (_, part) =>
    run('secret-tool', ['lookup', 'canonfig-key', match[1] + (part ? `.${part}` : '')], env)).join('');
};
const nativeItems = env => (run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets',
  '--object-path', '/org/freedesktop/secrets/collection/login', '--method', 'org.freedesktop.DBus.Properties.Get',
  'org.freedesktop.Secret.Collection', 'Items'], env).match(/'[^']*'/gu) ?? []).sort();

async function destinations() {
  const machine = fixture('destinations');
  cli(machine.env, ['backup', 'password', 'recovery', '--stdin'], 'synthetic maple frost library canvas\n');
  for (const compression of ['fast', 'balanced', 'small', 'max']) {
    configure(machine.env, compression, {...policy({kind: 'local', path: join(root, 'local')}), compression, passwordReference: 'recovery'});
    const captured = cli(machine.env, ['backup', 'run', compression]);
    assert.equal(captured.verifiedRemote, true);
    const output = join(root, `restored-${compression}`);
    cli(machine.env, ['backup', 'restore', compression, '--to', output]);
    restoredEqual(machine, output);
    assert.equal(cli(machine.env, ['backup', 'drill', compression]).restoredFiles, 2);
    evidence.push({check: `encrypted-${compression}`, restoredByteIdentical: true, codec: captured.snapshot.codec});
  }
  cli(machine.env, ['backup', 'password', 'wrong', '--stdin'], 'synthetic wrong password\n');
  configure(machine.env, 'balanced', {...policy({kind: 'local', path: join(root, 'local')}), passwordReference: 'wrong'});
  const refused = spawnSync(process.execPath, [main, 'backup', 'restore', 'balanced', '--to', join(root, 'wrong'), '--json'], {env: machine.env, encoding: 'utf8'});
  assert.notEqual(refused.status, 0);
  assert.equal(existsSync(join(root, 'wrong')), false);
  evidence.push({check: 'wrong-password', exit: refused.status, destinationAbsent: true});

  const bare = join(root, 'bare.git');
  run('git', ['init', '--bare', '--quiet', bare], machine.env);
  const rcloneConfig = join(root, 'rclone.conf');
  writeFileSync(rcloneConfig, '[proof]\ntype = local\n', {mode: 0o600});
  machine.env.RCLONE_CONFIG = rcloneConfig;
  for (const [name, destination] of [['git', {kind: 'git', remote: bare}], ['rclone', {kind: 'rclone', remote: `proof:${join(root, 'rclone')}`} ]]) {
    configure(machine.env, name, policy(destination));
    assert.equal(cli(machine.env, ['backup', 'run', name]).verifiedRemote, true);
    const output = join(root, `restored-${name}`);
    cli(machine.env, ['backup', 'restore', name, '--to', output]);
    restoredEqual(machine, output);
    evidence.push({check: name, plaintextScan: name === 'git', restoredByteIdentical: true});
  }
  // A plausible token in an ordinary instruction file must prevent plaintext Git publication.
  writeFileSync(join(machine.folder, 'AGENTS.md'), `github_token = ghp_${'Ab9x'.repeat(9)}\n`);
  const rejected = spawnSync(process.execPath, [main, 'backup', 'run', 'git', '--json'], {env: machine.env, encoding: 'utf8'});
  assert.notEqual(rejected.status, 0);
  assert.equal(cli(machine.env, ['backup', 'list', 'git']).snapshots.length, 1);
  writeFileSync(join(machine.folder, 'AGENTS.md'), '# Disposable backup proof\nPreserve these exact bytes.\n');
  evidence.push({check: 'plaintext-git-secret-scan', exit: rejected.status, snapshotsUnchanged: true});

  const forgejo = join(root, 'forgejo');
  mkdirSync(forgejo);
  const config = join(forgejo, 'app.ini');
  writeFileSync(config, `RUN_USER = ${process.env.USER}\nWORK_PATH = ${forgejo}\n[database]\nDB_TYPE = sqlite3\nPATH = ${forgejo}/forgejo.db\n[repository]\nROOT = ${forgejo}/repositories\n[server]\nHTTP_ADDR = 127.0.0.1\nHTTP_PORT = 3309\nROOT_URL = http://127.0.0.1:3309/\nSTART_SSH_SERVER = true\nSSH_DOMAIN = 127.0.0.1\nSSH_PORT = 2229\nSSH_LISTEN_PORT = 2229\nSSH_LISTEN_HOST = 127.0.0.1\nAPP_DATA_PATH = ${forgejo}/data\n[security]\nINSTALL_LOCK = true\nSECRET_KEY = ${randomBytes(32).toString('hex')}\n[service]\nDISABLE_REGISTRATION = true\n[log]\nMODE = console\nLEVEL = error\n`, {mode: 0o600});
  const server = launch('forgejo', ['web', '-w', forgejo, '-c', config], machine.env);
  server.stdout.resume(); server.stderr.resume();
  await ready('http://127.0.0.1:3309/api/v1/version', server);
  const created = run('forgejo', ['admin', 'user', 'create', '-w', forgejo, '-c', config, '--username', 'proof', '--email', 'proof@example.invalid', '--random-password', '--must-change-password=false', '--access-token'], machine.env);
  const token = created.match(/\b[0-9a-f]{40}\b/u)?.[0];
  assert(token, 'Fixture admin returned no access token');
  const api = async (path, body) => {
    const response = await fetch(`http://127.0.0.1:3309/api/v1/${path}`, {method: 'POST', headers: {'content-type': 'application/json', authorization: `token ${token}`}, body: JSON.stringify(body)});
    assert(response.ok, `Fixture Forgejo API returned ${response.status}`);
    return response.json();
  };
  const repository = await api('user/repos', {name: 'backups', private: true});
  const key = join(root, 'forgejo-key');
  run('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key], machine.env);
  await api('user/keys', {title: 'disposable-proof', key: readFileSync(`${key}.pub`, 'utf8')});
  const knownHosts = join(root, 'known-hosts');
  writeFileSync(knownHosts, run('ssh-keyscan', ['-p', '2229', '127.0.0.1'], machine.env));
  machine.env.GIT_SSH_COMMAND = `ssh -i ${key} -o IdentitiesOnly=yes -o UserKnownHostsFile=${knownHosts}`;
  assert.equal(new URL(repository.ssh_url).hostname, '127.0.0.1');
  run('git', ['ls-remote', repository.ssh_url], machine.env);
  configure(machine.env, 'forgejo', {...policy({kind: 'git', remote: repository.ssh_url}), passwordReference: 'recovery'});
  assert.equal(cli(machine.env, ['backup', 'run', 'forgejo']).verifiedRemote, true);
  const output = join(root, 'restored-forgejo');
  cli(machine.env, ['backup', 'restore', 'forgejo', '--to', output]);
  restoredEqual(machine, output);
  evidence.push({check: 'forgejo-17.0.1-ssh', restoredByteIdentical: true});
}

async function sourceFollower() {
  let source = fixture('source');
  source.env = nativeEnvFor(source.home);
  const followerHome = process.env.HOME;
  assert.equal(followerHome, '/home/canonfig-proof');
  assert.equal(existsSync(join(followerHome, '.canonfig')), false, 'Proof user must have no existing installation');
  const keyringData = join(root, 'keyring-data');
  mkdirSync(keyringData, {mode: 0o700});
  // Keep credentials on a private bus; the Follower's native scheduler still uses its user bus.
  const bus = launch('dbus-daemon', ['--session', '--nofork', '--print-address=1'], source.env);
  bus.stderr.resume();
  const lines = createInterface({input: bus.stdout});
  const [address] = await once(lines, 'line');
  lines.close(); bus.stdout.resume();
  source.env.DBUS_SESSION_BUS_ADDRESS = address;
  const keyringControl = join(root, 'keyring-control');
  mkdirSync(keyringControl, {mode: 0o700});
  const keyringEnv = {...source.env, XDG_DATA_HOME: keyringData};
  const keyring = launch('gnome-keyring-daemon', ['--foreground', '--unlock', '--components=secrets', '--control-directory', keyringControl], keyringEnv, 'synthetic disposable keyring password\n');
  keyring.stdout.resume(); keyring.stderr.resume();
  await once(keyring.stdin, 'finish');
  run('gdbus', ['wait', '--session', '--timeout', '30', 'org.freedesktop.secrets'], source.env);
  const followerEnv = envFor(followerHome);
  const declared = policy({kind: 'local', path: join(root, 'follower-backups')});
  const profile = {version: 1, profile: {id: 'backup-proof', name: 'Backup proof'}, harnesses: [], backupPolicies: {inherited: declared}};
  cli(source.env, ['source', 'init']);
  writeFileSync(join(source.folder, 'canonfig.jsonc'), JSON.stringify(profile));
  cli(source.env, ['source', 'publish', '--reviewer', 'disposable-backup-proof']);
  const {server, endpoint} = await sourceServer(source.env);
  const invitation = join(root, 'invitation');
  cli(source.env, ['source', 'invite', '--endpoint', endpoint, '--output', invitation, '--expires', '5m']);
  cli(followerEnv, ['follower', 'enroll', '--stdin', '--name', 'backup-proof'], readFileSync(invitation, 'utf8'));
  cli(followerEnv, ['sync', '--apply', '--no-input']);
  const received = cli(followerEnv, ['backup', 'status']);
  assert.deepEqual(received.declared.inherited, declared);
  assert.equal(cli(followerEnv, ['backup', 'run', 'inherited']).verifiedRemote, true);
  assert.equal(cli(followerEnv, ['backup', 'drill', 'inherited']).restoredFiles, 2);
  evidence.push({check: 'signed-source-policy-to-follower', receivedAndExecuted: true});

  cli(source.env, ['secrets', 'set', 'proof-secret'], 'synthetic shared secret\n');
  cli(source.env, ['backup', 'password', 'source-recovery', '--stdin'], 'synthetic library maple recovery\n');
  configure(source.env, 'identity', {...policy({kind: 'local', path: join(root, 'identity')}), passwordReference: 'source-recovery', sourceIdentity: true, sharedSecrets: true}, true);
  cli(source.env, ['backup', 'run', 'identity']);
  const recoverySource = source;
  const itemsBefore = nativeItems(source.env);
  const drill = cli(source.env, ['backup', 'drill', 'identity']);
  assert.equal(drill.sourceIdentity, true);
  assert.equal(drill.secrets, 1);
  assert.deepEqual(nativeItems(source.env), itemsBefore, 'Drill left native credentials behind');
  const occupied = join(root, 'occupied');
  mkdirSync(occupied); writeFileSync(join(occupied, 'sentinel'), 'untouched');
  const refused = spawnSync(process.execPath, [main, 'backup', 'restore', 'identity', '--to', occupied, '--recover-credentials', '--json'], {env: source.env, encoding: 'utf8'});
  assert.notEqual(refused.status, 0);
  assert.equal(readFileSync(join(occupied, 'sentinel'), 'utf8'), 'untouched');
  assert.deepEqual(nativeItems(source.env), itemsBefore, 'Failed restore left native credentials behind');
  evidence.push({check: 'native-recovery-rollback-and-drill', existingCredentialsPreserved: true, temporaryReferencesRemoved: true});
  const recovered = join(root, 'recovered-source');
  cli(source.env, ['backup', 'restore', 'identity', '--to', recovered, '--recover-credentials']);
  const before = new DatabaseSync(join(source.folder, 'state.sqlite'), {readOnly: true});
  const after = new DatabaseSync(join(recovered, '.canonfig', 'state.sqlite'), {readOnly: true});
  try {
    assert.deepEqual(after.prepare('SELECT id, revoked FROM followers ORDER BY id').all(), before.prepare('SELECT id, revoked FROM followers ORDER BY id').all());
    const original = before.prepare('SELECT signing_key_reference, tls_key_reference, tls_certificate_reference FROM enrollment_source').get();
    const restored = after.prepare('SELECT signing_key_reference, tls_key_reference, tls_certificate_reference FROM enrollment_source').get();
    for (const name of Object.keys(original)) {
      assert.notEqual(restored[name], original[name]);
      assert(credential(restored[name], source.env) === credential(original[name], source.env), 'Recovered identity bytes differ');
    }
  } finally { before.close(); after.close(); }
  const secret = JSON.parse(readFileSync(join(recovered, '.canonfig', 'secrets.json'), 'utf8')).secrets[0];
  const originalSecret = JSON.parse(readFileSync(join(source.folder, 'secrets.json'), 'utf8')).secrets[0];
  assert(credential(secret.reference, source.env) === credential(originalSecret.reference, source.env), 'Recovered shared secret differs');
  assert.equal(existsSync(join(recovered, '.canonfig', 'credentials')), false);
  await stop(server);
  source = {home: recovered, folder: join(recovered, '.canonfig'), env: {...nativeEnvFor(recovered), DBUS_SESSION_BUS_ADDRESS: address}};
  const restoredServer = await sourceServer(source.env);
  assert.equal(restoredServer.endpoint, endpoint);
  cli(followerEnv, ['sync', '--apply', '--no-input']);
  cli(source.env, ['secrets', 'list']);
  evidence.push({check: 'source-identity-and-shared-secret-recovery', keysByteIdentical: true, registryIdentical: true, newNativeReferences: true, authenticatedFollowerSync: true});

  const scheduledTime = offset => new Date(Date.now() + offset).toISOString().slice(11, 16);
  declared.schedule = {kind: 'daily', localTime: scheduledTime(90_000), timezone: 'UTC'};
  declared.drillSchedule = {kind: 'daily', localTime: scheduledTime(150_000), timezone: 'UTC'};
  writeFileSync(join(source.folder, 'canonfig.jsonc'), JSON.stringify(profile));
  cli(source.env, ['source', 'publish', '--reviewer', 'disposable-backup-proof']);
  cli(followerEnv, ['sync', '--apply', '--no-input']);
  const scheduled = cli(followerEnv, ['backup', 'status']);
  assert.equal(scheduled.schedules.length, 2);
  const previous = cli(followerEnv, ['backup', 'list', 'inherited']).snapshots.map(snapshot => snapshot.id);
  const deadline = Date.now() + 210_000;
  for (const action of ['run', 'drill']) {
    for (;;) {
      const state = Object.fromEntries(run('systemctl', ['--user', 'show', `canonfig-backup-inherited-${action}.service`,
        '--property=ExecMainStartTimestampMonotonic,ActiveState,ExecMainStatus'], followerEnv).trim().split('\n').map(line => line.split('=')));
      if (state.ExecMainStartTimestampMonotonic !== '0' && state.ActiveState === 'inactive') { assert.equal(state.ExecMainStatus, '0'); break; }
      assert.notEqual(state.ActiveState, 'failed', `Native ${action} job failed`);
      assert(Date.now() < deadline, `Native ${action} timer did not fire`);
      await new Promise(resolve => setTimeout(resolve, 500));
    }
  }
  const snapshots = cli(followerEnv, ['backup', 'list', 'inherited']).snapshots;
  assert(snapshots.some(snapshot => !previous.includes(snapshot.id)));
  cli(followerEnv, ['backup', 'disable', 'inherited']);
  assert.equal(cli(followerEnv, ['backup', 'status']).schedules.length, 0);
  evidence.push({check: 'native-systemd-backup-and-drill', timerFired: true, newSnapshot: true, exitCodes: [0, 0], removedAfterDisable: true});
  run('gdbus', ['call', '--session', '--dest', 'org.freedesktop.secrets', '--object-path', '/org/freedesktop/secrets',
    '--method', 'org.freedesktop.Secret.Service.Lock', '["/org/freedesktop/secrets/collection/login"]'], recoverySource.env);
  const lockedOutput = join(root, 'locked-restore');
  const trace = join(root, 'locked-restore.trace');
  const locked = spawnSync('strace', ['-f', '-e', 'trace=openat,creat', '-o', trace, process.execPath, main,
    'backup', 'restore', 'identity', '--to', lockedOutput, '--recover-credentials', '--json'], {env: recoverySource.env, encoding: 'utf8', timeout: 180_000});
  assert.equal(locked.status, 3, 'Locked storage must be Human Action Required');
  assert.match(JSON.parse(locked.stderr).message, /credential store/u);
  assert.equal(existsSync(lockedOutput), false);
  assert.equal(/"[^"]*(?:credentials\.json|archive\.tar|\/decrypted)"[^\n]*O_(?:WRONLY|RDWR)/u.test(readFileSync(trace, 'utf8')), false);
  evidence.push({check: 'locked-native-store', exit: locked.status, destinationAbsent: true, noPlaintextCredentialWrites: true});
  rmSync(join(followerHome, '.canonfig'), {recursive: true});
  rmSync(join(followerHome, 'credentials'), {recursive: true, force: true});
}

try {
  if (process.argv[2] === 'destinations') await destinations();
  else if (process.argv[2] === 'source-follower') await sourceFollower();
  else throw new Error('Choose destinations or source-follower');
  const report = {node: process.version, mode: process.argv[2], evidence};
  if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
} finally {
  for (const child of children.reverse()) await stop(child);
  rmSync(root, {recursive: true, force: true});
}
