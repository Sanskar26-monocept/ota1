#!/usr/bin/env node
/**
 * Builds an APK from an eas.json build profile and publishes it on the xprem
 * server as an install link. The build also appears in the dashboard under
 * Builds. The profile decides the channel the APK polls for OTA updates, so
 * preview, staging and production builds stay separate.
 *
 *   npm run build:server                       # build on the server (profile: production)
 *   npm run build:preview                      # profile preview, on the server
 *   npm run build:apk -- --profile staging     # build on this machine instead
 *
 *   --profile <name>     eas.json build profile (default: production)
 *   --remote | --local   where to build (default: --local)
 *   --channel <name>     override the profile's channel
 *   --no-wait            (remote) queue the build and return at once
 *   --prebuild           (local) regenerate android/ first
 *   --skip-build         (local) upload the APK already built
 *   -m "note"            note shown on the install page
 *   --dry-run            show what would happen, change nothing
 *
 * Needs EOO_TOKEN (an API token of the app, from the dashboard's API tokens
 * page) in .env.xprem or in the environment.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');

const projectRoot = path.join(__dirname, '..');
const androidDir = path.join(projectRoot, 'android');
const apkRoot = path.join(androidDir, 'app', 'build', 'outputs', 'apk');
const envFile = path.join(projectRoot, '.env.xprem');
const easFile = path.join(projectRoot, 'eas.json');

const argv = process.argv.slice(2);
const hasFlag = name => argv.includes(name);
const flagValue = (...names) => {
  for (const name of names) {
    const index = argv.indexOf(name);
    if (index !== -1 && argv[index + 1] && !argv[index + 1].startsWith('--')) {
      return argv[index + 1];
    }
  }
  return undefined;
};

function fail(message) {
  console.error(`\n✖ ${message}`);
  process.exit(1);
}

// .env.xprem fills in what the environment does not already set, so a CI job
// can pass EOO_TOKEN directly.
function loadEnv() {
  const env = { ...process.env };
  if (fs.existsSync(envFile)) {
    for (const rawLine of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const index = line.indexOf('=');
      if (index === -1) continue;
      const key = line.slice(0, index).trim();
      if (!env[key]) env[key] = line.slice(index + 1).trim();
    }
  }
  return env;
}

// --- eas.json profiles ---

// The profile as the build uses it: `extends` chains are flattened, the child
// winning, and env maps merged.
function resolveProfile(name) {
  let eas = {};
  if (fs.existsSync(easFile)) {
    try {
      eas = JSON.parse(fs.readFileSync(easFile, 'utf8'));
    } catch (error) {
      fail(`eas.json is not valid JSON: ${error.message}`);
    }
  }
  const profiles = eas.build || {};
  const flatten = (profileName, seen = []) => {
    const profile = profiles[profileName];
    if (!profile) fail(`Build profile "${profileName}" is not defined in eas.json.`);
    if (seen.includes(profileName)) fail(`eas.json: profile "${profileName}" extends itself.`);
    const parent = profile.extends ? flatten(profile.extends, [...seen, profileName]) : {};
    return {
      ...parent,
      ...profile,
      env: { ...parent.env, ...profile.env },
      android: { ...parent.android, ...profile.android },
    };
  };

  if (!profiles[name]) {
    // Without an eas.json (or a production profile) the old behaviour holds:
    // the profile name is the channel.
    if (name === 'production' || !Object.keys(profiles).length) {
      return { name, channel: name, env: {}, gradleCommand: 'assembleRelease' };
    }
    fail(`Build profile "${name}" is not defined in eas.json. Available: ${Object.keys(profiles).join(', ')}.`);
  }
  const profile = flatten(name);
  const buildType = profile.android.buildType;
  if (buildType && buildType !== 'apk') {
    fail(`Profile "${name}": android.buildType "${buildType}" is not supported, only "apk".`);
  }
  // EAS spells the task ":app:assembleRelease"; Gradle runs it from android/.
  const gradleCommand = String(profile.android.gradleCommand || 'assembleRelease').replace(/^:app:/, '');
  if (!/^assemble[A-Z][A-Za-z0-9]*$/.test(gradleCommand)) {
    fail(`Profile "${name}": android.gradleCommand must be an assemble task such as :app:assembleRelease.`);
  }
  return { name, channel: profile.channel || name, env: profile.env, gradleCommand };
}

// --- helpers shared by both modes ---

// Commands run through a shell (npx and gradlew.bat cannot be spawned directly
// on Windows), as one string: every command here is a fixed literal.
function run(command, cwd, env) {
  console.log(`\n> ${command}`);
  const result = spawnSync(command, { cwd, env, stdio: 'inherit', shell: true });
  if (result.status !== 0) {
    fail(`${command} exited with code ${result.status}`);
  }
}

// app.config.js reads RELEASE_CHANNEL and the profile's env, so the Expo CLI
// resolves it: that is exactly the config the build bakes into the APK.
function resolveConfig(env) {
  const result = spawnSync('npx expo config --json --type public', {
    cwd: projectRoot,
    env,
    encoding: 'utf8',
    shell: true,
  });
  if (result.status !== 0) {
    fail(`Could not resolve the Expo config:\n${result.stderr || result.stdout}`);
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    fail(`Unexpected output from "expo config":\n${result.stdout}`);
  }
}

// With ABI splits Gradle writes one APK per ABI; the universal one installs
// on every device, so it wins. Any variant's folder is searched, since the
// profile's Gradle task decides where the APK lands.
function findApk() {
  const apks = [];
  const walk = dir => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.toLowerCase().endsWith('.apk')) apks.push({ full, mtime: fs.statSync(full).mtimeMs });
    }
  };
  walk(apkRoot);
  if (!apks.length) return null;
  const universal = apks.find(apk => /universal/i.test(path.basename(apk.full)));
  return (universal || apks.sort((a, b) => b.mtime - a.mtime)[0]).full;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: projectRoot, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : undefined;
}

// The Expo SDK the app builds against, from the installed expo package.
function expoSdkVersion() {
  try {
    return require(path.join(projectRoot, 'node_modules', 'expo', 'package.json')).version;
  } catch {
    return undefined;
  }
}

// The machine that ran the build, as the dashboard shows it ("Windows x64").
function buildHost() {
  const names = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  return `${names[process.platform] || process.platform} ${os.arch()}`;
}

// Whether the working tree has uncommitted changes, so the dashboard can mark
// the commit the way EAS does (5e10bf1*). Unknown outside a git checkout.
function gitDirty() {
  const status = git(['status', '--porcelain']);
  return status === undefined ? undefined : String(status !== '');
}

// The files of the project the build was made from, the way git sees it:
// tracked files plus untracked ones that are not ignored, so node_modules and
// build output stay out. Undefined outside a git checkout.
function projectFiles() {
  const result = spawnSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: projectRoot,
    encoding: 'utf8',
    maxBuffer: 64 << 20,
  });
  if (result.status !== 0) return undefined;
  // --cached still names files deleted from the working tree. The token file
  // never leaves this machine, tracked or not.
  return [...new Set(result.stdout.split('\0').filter(Boolean))].filter(
    file => file !== '.env.xprem' && fs.existsSync(path.join(projectRoot, file))
  );
}

// Sent after the upload, so a failure here never costs the build itself.
async function sendProjectFiles(serverUrl, appId, channel, buildId, token) {
  const files = (projectFiles() || []).slice(0, 50000);
  if (!files.length) {
    console.log('   Project files not listed: this is not a git checkout.');
    return;
  }
  try {
    const response = await fetch(
      `${serverUrl}/${appId}/uploadBuild/${encodeURIComponent(channel)}/${buildId}/projectFiles`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ files }),
      }
    );
    if (response.status === 404 || response.status === 405) {
      console.log('   Project files not listed: the server does not support it yet.');
    } else if (!response.ok) {
      console.log(`   Project files not listed: the server answered ${response.status}.`);
    } else {
      console.log(`📂 Project files listed on the build's page: ${files.length}`);
    }
  } catch (error) {
    console.log(`   Project files not listed: ${error.cause?.message || error.message}`);
  }
}

async function errorDetail(response) {
  const text = await response.text();
  try {
    return (JSON.parse(text).detail || text).trim();
  } catch {
    // Auth refusals come back as plain text.
    return text.trim();
  }
}

function authHint(status) {
  return status === 401
    ? '\n  Check EOO_TOKEN: it must be an API token of this app (dashboard → API tokens).'
    : status === 404
      ? '\n  The server may not have the Builds feature, or the app id is wrong.'
      : '';
}

function printResult(build) {
  console.log('\n✅ Build ready');
  console.log(`📱 Install link (share it with testers): ${build.shareUrl}`);
  console.log(`⬇️  Direct APK download:                 ${build.downloadUrl}`);
  // Servers from before build expiry send no expiresAt.
  if (build.expiresAt) {
    console.log(`⏳ Link expires:                        ${new Date(build.expiresAt).toLocaleString()}`);
  }
  console.log('   Anyone with the link can install it until it expires. Delete the build in the dashboard (Builds) to revoke the link sooner.');
}

// --- local build: Gradle here, upload the APK ---

async function upload(uploadUrl, apkPath, token) {
  const apk = fs.readFileSync(apkPath);
  console.log(`\n📤 Uploading ${path.basename(apkPath)} (${(apk.length / 1048576).toFixed(1)} MB)...`);
  let response;
  try {
    response = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/vnd.android.package-archive',
      },
      body: apk,
    });
  } catch (error) {
    fail(`Could not reach the server: ${error.cause?.message || error.message}`);
  }
  if (!response.ok) {
    fail(`Upload failed (${response.status}): ${await errorDetail(response)}${authHint(response.status)}`);
  }
  return response.json();
}

async function buildLocally(ctx) {
  const { env, profile, serverUrl, appId, config, metadata, dryRun } = ctx;
  const params = new URLSearchParams({ platform: 'android' });
  for (const [key, value] of Object.entries(metadata)) {
    if (value) params.set(key, value);
  }
  params.set('buildProfile', profile.name);
  params.set('buildHost', buildHost());
  params.set('cliVersion', `build-apk.js (Node ${process.versions.node})`);

  const prebuild = hasFlag('--prebuild') || !fs.existsSync(androidDir);
  const skipBuild = hasFlag('--skip-build');

  if (dryRun) {
    const apk = findApk();
    console.log(`  where:           this machine`);
    console.log(`  steps:           ${skipBuild ? 'upload the existing APK' : `${prebuild ? 'expo prebuild → ' : ''}gradlew ${profile.gradleCommand} → upload`}`);
    console.log(`  last APK:        ${apk ? path.relative(projectRoot, apk) : 'none built yet'}`);
    console.log(`  upload:          POST ${serverUrl}/${appId}/uploadBuild/${encodeURIComponent(profile.channel)}`);
    return;
  }

  if (!skipBuild) {
    const buildStart = Date.now();
    if (prebuild) {
      run('npx expo prebuild --platform android --no-install', projectRoot, env);
    }
    run(`${process.platform === 'win32' ? 'gradlew.bat' : './gradlew'} ${profile.gradleCommand}`, androidDir, env);
    // With --skip-build nothing was built here, so no build time is sent.
    params.set('buildDurationMs', String(Date.now() - buildStart));
  }

  const apkPath = findApk();
  if (!apkPath) {
    fail(`No APK in ${path.relative(projectRoot, apkRoot)}. Run without --skip-build.`);
  }
  params.set('fileName', path.basename(apkPath));

  const uploadUrl = `${serverUrl}/${appId}/uploadBuild/${encodeURIComponent(profile.channel)}?${params}`;
  const build = await upload(uploadUrl, apkPath, env.EOO_TOKEN);
  await sendProjectFiles(serverUrl, appId, profile.channel, build.id, env.EOO_TOKEN);
  printResult(build);
}

// --- server build: upload the project, the server runs Gradle ---

function pad(value, length) {
  return value.length >= length ? value : value + '\0'.repeat(length - value.length);
}

function octal(value, length) {
  return value.toString(8).padStart(length - 1, '0') + '\0';
}

// One tar header block (ustar). Names over 100 bytes go in a preceding PAX
// record, which the server's archive/tar reads.
function tarHeader(name, size, mode, typeflag) {
  const block = Buffer.alloc(512);
  const fields = [
    [0, pad(name.slice(0, 100), 100)],
    [100, octal(mode, 8)],
    [108, octal(0, 8)],
    [116, octal(0, 8)],
    [124, octal(size, 12)],
    [136, octal(0, 12)],
    [148, '        '],
    [156, typeflag],
    [257, 'ustar\0'],
    [263, '00'],
  ];
  for (const [offset, value] of fields) block.write(value, offset, 'latin1');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(octal(sum, 7) + ' ', 148, 'latin1');
  return block;
}

function tarEntry(name, content, mode) {
  const parts = [];
  if (Buffer.byteLength(name) > 100) {
    let record = ` path=${name}\n`;
    // The record starts with its own length, in decimal.
    for (let length = Buffer.byteLength(record) + 1; ; length++) {
      const candidate = `${length}${record}`;
      if (Buffer.byteLength(candidate) === length) {
        record = candidate;
        break;
      }
    }
    const body = Buffer.from(record);
    parts.push(tarHeader('PaxHeader', body.length, 0o644, 'x'), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(tarHeader(name, content.length, mode, '0'), content, Buffer.alloc((512 - (content.length % 512)) % 512));
  return Buffer.concat(parts);
}

// The project as a gzip-compressed tar, built from the files git sees (see
// projectFiles): no node_modules, no generated android/ or ios/, no secrets.
function createSourceArchive(files) {
  const chunks = [];
  let count = 0;
  for (const file of files) {
    const full = path.join(projectRoot, file);
    const stat = fs.lstatSync(full);
    // Links are skipped: the server never creates them.
    if (!stat.isFile()) continue;
    chunks.push(tarEntry(file.replace(/\\/g, '/'), fs.readFileSync(full), stat.mode & 0o111 ? 0o755 : 0o644));
    count++;
  }
  chunks.push(Buffer.alloc(1024));
  return { archive: zlib.gzipSync(Buffer.concat(chunks)), count };
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(url, token, init = {}) {
  const response = await fetch(url, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
  if (!response.ok) {
    const error = new Error(`${response.status}: ${await errorDetail(response)}${authHint(response.status)}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

async function buildOnServer(ctx) {
  const { env, profile, serverUrl, appId, metadata, dryRun } = ctx;
  const jobsUrl = `${serverUrl}/${appId}/buildJobs/${encodeURIComponent(profile.channel)}`;
  const files = projectFiles();
  if (!files) fail('Server builds upload the project through git: run this inside a git checkout.');

  if (dryRun) {
    console.log('  where:           the server');
    console.log(`  gradle task:     ${profile.gradleCommand}`);
    console.log(`  env sent:        ${Object.keys(profile.env).join(', ') || '—'}`);
    console.log(`  files:           ${files.length} (git-tracked and untracked, ignored files left out)`);
    console.log(`  steps:           upload project → install → expo prebuild → gradlew ${profile.gradleCommand} → install link`);
    console.log(`  upload:          POST ${jobsUrl}`);
    return;
  }

  const { archive, count } = createSourceArchive(files);
  console.log(`\n📦 Project archived: ${count} files, ${(archive.length / 1048576).toFixed(1)} MB`);
  const buildConfig = {
    profile: profile.name,
    gradleCommand: profile.gradleCommand,
    env: profile.env,
    message: metadata.message,
    commitHash: metadata.commitHash,
    gitBranch: metadata.gitBranch,
    gitDirty: metadata.gitDirty === undefined ? undefined : metadata.gitDirty === 'true',
    cliVersion: `build-apk.js (Node ${process.versions.node})`,
  };

  console.log(`📤 Uploading to ${serverUrl} (profile ${profile.name}, channel ${profile.channel})...`);
  let job;
  try {
    job = await api(jobsUrl, env.EOO_TOKEN, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/gzip',
        'X-Build-Config': Buffer.from(JSON.stringify(buildConfig)).toString('base64url'),
      },
      body: archive,
    });
  } catch (error) {
    fail(`Could not queue the build: ${error.cause?.message || error.message}`);
  }
  console.log(`🏗️  Build ${job.id} queued on the server.`);
  if (hasFlag('--no-wait')) {
    console.log(`   Follow it in the dashboard (Builds), or run without --no-wait.`);
    return;
  }

  // Ctrl+C stops the server build too, instead of leaving it running unseen.
  let interrupted = false;
  process.on('SIGINT', async () => {
    if (interrupted) process.exit(130);
    interrupted = true;
    console.log('\n⏹  Canceling the server build...');
    try {
      await api(`${jobsUrl}/${job.id}/cancel`, env.EOO_TOKEN, { method: 'POST' });
    } catch (error) {
      console.error(`Could not cancel: ${error.message}`);
    }
    process.exit(130);
  });

  console.log('   Streaming the build log (Ctrl+C cancels the build):\n');
  let offset = 0;
  let status = job.status;
  let failures = 0;
  while (true) {
    try {
      const chunk = await api(`${jobsUrl}/${job.id}/log?from=${offset}`, env.EOO_TOKEN);
      failures = 0;
      if (chunk.log) process.stdout.write(chunk.log);
      offset = chunk.length;
      status = chunk.status;
      // The status is read with the log, so a final one means nothing is left.
      if (['succeeded', 'failed', 'canceled'].includes(status)) break;
    } catch (error) {
      // A blip must not abandon a build that keeps running on the server.
      if (error.status === 404 || ++failures > 10) fail(`Lost track of build ${job.id}: ${error.message}`);
    }
    await sleep(2000);
  }

  const final = await api(`${jobsUrl}/${job.id}`, env.EOO_TOKEN);
  if (final.status === 'succeeded' && final.build) {
    printResult(final.build);
  } else if (final.status === 'canceled') {
    fail(`Build ${job.id} was canceled.`);
  } else {
    fail(`Build ${job.id} failed: ${final.error || 'see the log above'}`);
  }
}

async function main() {
  const env = loadEnv();
  const profileName = flagValue('--profile') || 'production';
  const profile = resolveProfile(profileName);
  const channel = flagValue('--channel');
  if (channel) profile.channel = channel;
  const dryRun = hasFlag('--dry-run');
  const remote = hasFlag('--remote') && !hasFlag('--local');

  // app.config.js puts RELEASE_CHANNEL into the expo-channel-name header; an
  // APK built without it polls no channel and never receives OTA updates.
  Object.assign(env, profile.env, { RELEASE_CHANNEL: profile.channel });

  if (!env.EOO_TOKEN && !dryRun) {
    fail('EOO_TOKEN is not set. Put it in .env.xprem (see .env.xprem.example).');
  }

  const config = resolveConfig(env);
  const appId = config.updates?.requestHeaders?.['expo-app-id'];
  const updateUrl = config.updates?.url;
  if (!appId || !updateUrl) {
    fail("app.json must define updates.url and updates.requestHeaders['expo-app-id'].");
  }
  const bakedChannel = config.updates.requestHeaders['expo-channel-name'];
  if (bakedChannel !== profile.channel) {
    fail(`The config bakes channel "${bakedChannel}" into the APK but the profile says "${profile.channel}". Is app.config.js missing?`);
  }
  const serverUrl = updateUrl.replace(/\/+$/, '').replace(/\/manifest$/, '');

  const metadata = {
    runtimeVersion: typeof config.runtimeVersion === 'string' ? config.runtimeVersion : undefined,
    appVersion: config.version,
    versionCode: config.android?.versionCode?.toString(),
    message: (flagValue('-m', '--message') || git(['log', '-1', '--pretty=%s']))?.slice(0, 255),
    commitHash: git(['rev-parse', 'HEAD']),
    gitBranch: (b => (b === 'HEAD' ? undefined : b))(git(['rev-parse', '--abbrev-ref', 'HEAD'])),
    gitDirty: gitDirty(),
    sdkVersion: expoSdkVersion(),
  };
  const ctx = { env, profile, serverUrl, appId, config, metadata, dryRun };

  if (dryRun) {
    console.log('Dry run, nothing is built or uploaded.\n');
    console.log(`  server:          ${serverUrl}`);
    console.log(`  app id:          ${appId}`);
    console.log(`  profile:         ${profile.name}`);
    console.log(`  channel:         ${profile.channel} (baked into the APK as "${bakedChannel}")`);
    console.log(`  app id/name:     ${config.android?.package} / ${config.name}`);
    for (const [key, value] of Object.entries(metadata)) {
      console.log(`  ${(key + ':').padEnd(17)}${value ?? '—'}`);
    }
    console.log(`  token:           ${env.EOO_TOKEN ? 'found' : 'MISSING (add it to .env.xprem)'}`);
  }

  await (remote ? buildOnServer(ctx) : buildLocally(ctx));
}

main();
