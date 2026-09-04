import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hubRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const supportedLanguages = new Set(['typescript', 'rust', 'python', 'cpp']);
const publishedTypeScriptPackages = ['core', 'web', 'server', 'react', 'svelte', 'vue', 'vite'];

function displayCommand(command, commandArguments) {
  return [command, ...commandArguments]
    .map((argument) =>
      /^[A-Za-z0-9_./:=@+,-]+$/.test(argument) ? argument : JSON.stringify(argument),
    )
    .join(' ');
}

function runCommand(command, commandArguments, workingDirectory, captureOutput = false) {
  console.log(`> ${displayCommand(command, commandArguments)}`);
  const commandResult = spawnSync(command, commandArguments, {
    cwd: workingDirectory,
    encoding: 'utf8',
    stdio: captureOutput ? ['ignore', 'pipe', 'pipe'] : 'inherit',
  });

  if (commandResult.error) {
    throw commandResult.error;
  }
  if (commandResult.status !== 0) {
    const capturedError = captureOutput ? commandResult.stderr.trim() : '';
    throw new Error(
      `Command failed with exit ${commandResult.status}: ${displayCommand(command, commandArguments)}${capturedError ? `\n${capturedError}` : ''}`,
    );
  }

  return captureOutput ? commandResult.stdout.trim() : '';
}

function commandSucceeds(command, commandArguments, workingDirectory) {
  const commandResult = spawnSync(command, commandArguments, {
    cwd: workingDirectory,
    stdio: 'ignore',
  });
  if (commandResult.error) {
    throw commandResult.error;
  }
  return commandResult.status === 0;
}

function runPnpm(commandArguments, workingDirectory) {
  if (process.platform === 'win32') {
    runCommand(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', 'pnpm', ...commandArguments],
      workingDirectory,
    );
    return;
  }
  runCommand('pnpm', commandArguments, workingDirectory);
}

function readJsonDocument(filePath) {
  return JSON.parse(readFileSync(filePath, 'utf8'));
}

function writeJsonDocument(filePath, document) {
  writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`);
}

function parseInvocation() {
  const commandArguments = process.argv.slice(2);
  const language = commandArguments[0];
  const skipGate = commandArguments.includes('--no-gate');
  const validShape =
    commandArguments.length === (skipGate ? 2 : 1) &&
    (!skipGate || commandArguments[1] === '--no-gate');

  if (!validShape || !supportedLanguages.has(language)) {
    throw new Error('Usage: node scripts/split-sdk.mjs <typescript|rust|python|cpp> [--no-gate]');
  }

  return { language, skipGate };
}

function assertCleanHub() {
  const status = runCommand(
    'git',
    ['status', '--porcelain=v1', '--untracked-files=all'],
    hubRoot,
    true,
  );
  if (status) {
    throw new Error(`Refusing to split a dirty tree:\n${status}`);
  }
}

function replaceSplitBranch(language) {
  const splitBranch = `split/${language}`;
  const candidateBranch = `split/${language}-candidate-${process.pid}`;
  const candidateReference = `refs/heads/${candidateBranch}`;
  const splitReference = `refs/heads/${splitBranch}`;

  try {
    runCommand(
      'git',
      ['subtree', 'split', `--prefix=sdks/${language}`, '-b', candidateBranch],
      hubRoot,
    );
    const candidateCommit = runCommand('git', ['rev-parse', candidateReference], hubRoot, true);

    if (commandSucceeds('git', ['show-ref', '--verify', '--quiet', splitReference], hubRoot)) {
      console.warn(`Warning: replacing existing branch ${splitBranch}.`);
    }
    runCommand('git', ['branch', '--force', splitBranch, candidateCommit], hubRoot);
    return splitBranch;
  } finally {
    if (commandSucceeds('git', ['show-ref', '--verify', '--quiet', candidateReference], hubRoot)) {
      runCommand('git', ['branch', '--delete', '--force', candidateBranch], hubRoot);
    }
  }
}

function moveSplitRoot(splitWorktree) {
  const splitRoot = join(splitWorktree, '.split-root');
  if (!existsSync(splitRoot)) {
    throw new Error(`Missing TypeScript split scaffold: ${splitRoot}`);
  }

  for (const entry of readdirSync(splitRoot)) {
    const destination = join(splitWorktree, entry);
    if (existsSync(destination)) {
      throw new Error(`Split scaffold destination already exists: ${destination}`);
    }
    renameSync(join(splitRoot, entry), destination);
  }
  rmSync(splitRoot, { recursive: true });
}

function rebaseTypeScriptConfigurations(splitWorktree) {
  for (const entry of readdirSync(splitWorktree, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const configurationPath = join(splitWorktree, entry.name, 'tsconfig.json');
    if (!existsSync(configurationPath)) {
      continue;
    }
    const configuration = readJsonDocument(configurationPath);
    if (Object.hasOwn(configuration, 'extends')) {
      configuration.extends = '../tsconfig.base.json';
      writeJsonDocument(configurationPath, configuration);
    }
  }

  const examplesDirectory = join(splitWorktree, 'examples');
  for (const entry of readdirSync(examplesDirectory, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const configurationPath = join(examplesDirectory, entry.name, 'tsconfig.json');
    if (!existsSync(configurationPath)) {
      continue;
    }
    const configuration = readJsonDocument(configurationPath);
    if (Object.hasOwn(configuration, 'extends')) {
      configuration.extends = '../../tsconfig.base.json';
      writeJsonDocument(configurationPath, configuration);
    }
  }
}

function rewriteTypeScriptPackageMetadata(splitWorktree) {
  const gatewayPackage = readJsonDocument(join(hubRoot, 'gateway', 'package.json'));
  const nodePromptsPath = join(splitWorktree, 'examples', 'node-prompts', 'package.json');
  const nodePromptsPackage = readJsonDocument(nodePromptsPath);
  nodePromptsPackage.devDependencies['@tesseron/mcp'] = `^${gatewayPackage.version}`;
  writeJsonDocument(nodePromptsPath, nodePromptsPackage);

  for (const packageDirectory of publishedTypeScriptPackages) {
    const packagePath = join(splitWorktree, packageDirectory, 'package.json');
    const packageDocument = readJsonDocument(packagePath);
    packageDocument.repository.url = 'git+https://github.com/Eigenwise/tesseron-typescript.git';
    packageDocument.repository.directory = packageDirectory;
    packageDocument.homepage = 'https://github.com/Eigenwise/tesseron-typescript#readme';
    packageDocument.bugs.url = 'https://github.com/Eigenwise/tesseron/issues';
    writeJsonDocument(packagePath, packageDocument);
  }
}

function runTypeScriptGate(splitWorktree) {
  runPnpm(['typecheck'], splitWorktree);
  runPnpm(['test'], splitWorktree);
  runPnpm(['lint'], splitWorktree);
  runPnpm(['build'], splitWorktree);
}

function prepareTypeScriptSplit(splitWorktree, hubCommit, skipGate) {
  moveSplitRoot(splitWorktree);
  rebaseTypeScriptConfigurations(splitWorktree);
  rewriteTypeScriptPackageMetadata(splitWorktree);
  runPnpm(['install', '--lockfile-only'], splitWorktree);
  runPnpm(['install', '--frozen-lockfile'], splitWorktree);

  if (!skipGate) {
    runTypeScriptGate(splitWorktree);
  }

  runCommand('git', ['add', '--all'], splitWorktree);
  runCommand(
    'git',
    [
      'commit',
      '--signoff',
      '-m',
      `chore: scaffold the standalone repository (split from hub ${hubCommit})`,
    ],
    splitWorktree,
  );

  const status = runCommand('git', ['status', '--porcelain=v1'], splitWorktree, true);
  if (status) {
    throw new Error(`TypeScript split worktree is dirty after scaffold commit:\n${status}`);
  }
}

function runRustGate(splitWorktree) {
  runCommand('cargo', ['fmt', '--all', '--check'], splitWorktree);
  runCommand(
    'cargo',
    ['clippy', '--workspace', '--all-targets', '--', '-D', 'warnings'],
    splitWorktree,
  );
  runCommand('cargo', ['test', '--workspace'], splitWorktree);
}

function runPythonGate(splitWorktree) {
  runCommand('uv', ['sync', '--locked'], splitWorktree);
  runCommand('uv', ['run', '--locked', 'ruff', 'check', '.'], splitWorktree);
  runCommand('uv', ['run', '--locked', 'ruff', 'format', '--check', '.'], splitWorktree);
  runCommand('uv', ['run', '--locked', 'mypy', '--strict', 'src', 'tests'], splitWorktree);
  runCommand('uv', ['run', '--locked', 'pytest'], splitWorktree);
  runCommand('uv', ['build'], splitWorktree);
}

function runCppGate(splitWorktree) {
  runCommand(
    'cmake',
    [
      '-S',
      '.',
      '-B',
      'build',
      '-G',
      'Ninja',
      '-DTESSERON_BUILD_TESTS=ON',
      '-DTESSERON_BUILD_CONFORMANCE_HOST=ON',
    ],
    splitWorktree,
  );
  runCommand('cmake', ['--build', 'build'], splitWorktree);
  runCommand('ctest', ['--test-dir', 'build', '--output-on-failure'], splitWorktree);
}

function runStandaloneGate(language, splitWorktree) {
  if (language === 'rust') {
    runRustGate(splitWorktree);
  } else if (language === 'python') {
    runPythonGate(splitWorktree);
  } else if (language === 'cpp') {
    runCppGate(splitWorktree);
  }
}

function removeWorktree(splitWorktree, temporaryDirectory) {
  try {
    runCommand('git', ['worktree', 'remove', '--force', splitWorktree], hubRoot);
  } catch {
    rmSync(splitWorktree, { recursive: true, force: true });
    runCommand('git', ['worktree', 'prune'], hubRoot);
  } finally {
    rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function printSplitResult(language, splitBranch) {
  const branchCommit = runCommand('git', ['rev-parse', splitBranch], hubRoot, true);
  console.log(`Branch tip: ${branchCommit}`);
  console.log(
    `Push when ready: git push git@github.com:Eigenwise/tesseron-${language}.git ${splitBranch}:main`,
  );
}

function main() {
  const { language, skipGate } = parseInvocation();
  assertCleanHub();
  const hubCommit = runCommand('git', ['rev-parse', 'HEAD'], hubRoot, true);
  const splitBranch = replaceSplitBranch(language);
  const temporaryDirectory = mkdtempSync(join(tmpdir(), `tesseron-${language}-split-`));
  const splitWorktree = join(temporaryDirectory, 'worktree');
  let worktreeAdded = false;
  let operationError;

  try {
    runCommand('git', ['worktree', 'add', splitWorktree, splitBranch], hubRoot);
    worktreeAdded = true;
    if (language === 'typescript') {
      prepareTypeScriptSplit(splitWorktree, hubCommit, skipGate);
    } else if (!skipGate) {
      runStandaloneGate(language, splitWorktree);
    }
  } catch (error) {
    operationError = error;
  } finally {
    try {
      if (worktreeAdded) {
        removeWorktree(splitWorktree, temporaryDirectory);
      } else {
        rmSync(temporaryDirectory, { recursive: true, force: true });
      }
    } catch (error) {
      operationError ??= error;
    }
    printSplitResult(language, splitBranch);
  }

  if (operationError) {
    throw operationError;
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
