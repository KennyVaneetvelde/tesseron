#!/usr/bin/env node
import { join, resolve } from 'node:path';
import { FixtureSchemaError } from './fixtures.js';
import { runSuite } from './runner.js';
import type { SuiteReport } from './types.js';

interface CliOptions {
  hostCommand: string;
  fixturesDirectory: string;
  only?: string;
  json: boolean;
}

async function main(): Promise<void> {
  try {
    const parsed = parseArguments(process.argv.slice(2));
    if (parsed === 'help') {
      process.stdout.write(`${usage()}\n`);
      return;
    }

    const report = await runSuite({
      hostCommand: parsed.hostCommand,
      fixturesDirectory: parsed.fixturesDirectory,
      only: parsed.only,
      unsupported: process.env['TESSERON_CONFORMANCE_UNSUPPORTED'],
    });
    if (parsed.json) process.stdout.write(`${JSON.stringify(report)}\n`);
    else printHumanReport(report);
    process.exitCode = report.exitCode;
  } catch (error) {
    if (error instanceof FixtureSchemaError) {
      process.stderr.write(
        `Fixture schema error:\n${error.problems.map((problem) => `  - ${problem}`).join('\n')}\n`,
      );
    } else {
      process.stderr.write(`${errorMessage(error)}\n`);
    }
    process.exitCode = 2;
  }
}

function parseArguments(arguments_: string[]): CliOptions | 'help' {
  let hostCommand: string | undefined;
  let fixturesDirectory = join(__dirname, 'fixtures');
  let only: string | undefined;
  let json = false;

  for (let index = 0; index < arguments_.length; index += 1) {
    const argument = arguments_[index]!;
    if (argument === '--help' || argument === '-h') return 'help';
    if (argument === '--json') {
      if (json) throw new Error('--json may be given only once');
      json = true;
      continue;
    }
    if (argument === '--host' || argument === '--fixtures' || argument === '--only') {
      const value = arguments_[index + 1];
      if (!value || value.startsWith('--'))
        throw new Error(`${argument} requires a value\n${usage()}`);
      index += 1;
      if (argument === '--host') {
        if (hostCommand !== undefined) throw new Error('--host may be given only once');
        hostCommand = value;
      } else if (argument === '--fixtures') {
        fixturesDirectory = resolve(value);
      } else {
        only = value;
      }
      continue;
    }
    throw new Error(`Unknown argument: ${argument}\n${usage()}`);
  }

  if (!hostCommand) throw new Error(`--host is required\n${usage()}`);
  return { hostCommand, fixturesDirectory, only, json };
}

function printHumanReport(report: SuiteReport): void {
  for (const id of report.passed) process.stdout.write(`PASS ${id}\n`);
  for (const skipped of report.skipped) {
    process.stdout.write(`SKIP ${skipped.id} missing ${skipped.missing.join(',')}\n`);
  }
  for (const failure of report.failed) {
    process.stdout.write(
      `FAIL ${failure.id} step ${failure.stepIndex}: expected ${JSON.stringify(failure.expected)}; actual ${JSON.stringify(failure.actual)}\n`,
    );
  }
  process.stdout.write(
    `summary: ${report.summary.passed} passed, ${report.summary.skipped} skipped, ${report.summary.failed} failed\n`,
  );
}

function usage(): string {
  return 'Usage: tesseron-conformance --host "<command>" [--fixtures <dir>] [--only <id glob>] [--json]';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

void main();
