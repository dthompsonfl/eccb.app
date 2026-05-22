#!/usr/bin/env tsx

/**
 * Dependency Check Script
 * Checks for outdated dependencies and provides update recommendations
 */

import { execSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

// Colors for terminal output
const colors = {
  red: '\x1b[0;31m',
  green: '\x1b[0;32m',
  yellow: '\x1b[1;33m',
  blue: '\x1b[0;34m',
  cyan: '\x1b[0;36m',
  reset: '\x1b[0m',
};

interface OutdatedPackage {
  current: string;
  wanted: string;
  latest: string;
  dependent: string;
  name: string;
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function log(message: string, color: keyof typeof colors = 'reset'): void {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function getOutdatedPackages(): OutdatedPackage[] {
  try {
    const output = execSync('pnpm outdated --format json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: process.cwd(),
    }).toString();

    if (!output.trim()) {
      return [];
    }

    const outdated = JSON.parse(output);
    return Object.entries(outdated).map(([name, info]) => ({
      name,
      ...(info as Omit<OutdatedPackage, 'name'>),
    }));
  } catch (error) {
    // pnpm outdated returns exit code 1 when packages are outdated
    const output = (error as { stdout?: string })?.stdout;
    if (output && output.trim()) {
      const outdated = JSON.parse(output);
      return Object.entries(outdated).map(([name, info]) => ({
        name,
        ...(info as Omit<OutdatedPackage, 'name'>),
      }));
    }
    return [];
  }
}

function getPackageJson(): PackageJson {
  const packageJsonPath = join(process.cwd(), 'package.json');
  if (!existsSync(packageJsonPath)) {
    log('Error: package.json not found', 'red');
    process.exit(1);
  }
  return JSON.parse(readFileSync(packageJsonPath, 'utf-8'));
}

function checkVulnerabilities(): { count: number; summary: string } {
  try {
    const output = execSync('pnpm audit --json', {
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).toString();

    if (!output.trim()) {
      return { count: 0, summary: 'No vulnerabilities' };
    }

    const audit = JSON.parse(output);
    const vulnerabilities = audit.metadata?.vulnerabilities || {};
    const total = Object.values(vulnerabilities).reduce(
      (sum: number, count) => sum + (count as number),
      0
    );

    const parts: string[] = [];
    if (vulnerabilities.critical) parts.push(`${vulnerabilities.critical} critical`);
    if (vulnerabilities.high) parts.push(`${vulnerabilities.high} high`);
    if (vulnerabilities.moderate) parts.push(`${vulnerabilities.moderate} moderate`);
    if (vulnerabilities.low) parts.push(`${vulnerabilities.low} low`);

    return { count: total, summary: parts.join(', ') || 'No vulnerabilities' };
  } catch {
    return { count: 0, summary: 'Unable to check vulnerabilities' };
  }
}

function formatVersion(current: string, wanted: string, latest: string): string {
  let result = current;

  if (current !== wanted) {
    result += ` → ${colors.yellow}${wanted}${colors.reset} (wanted)`;
  }

  if (current !== latest && wanted !== latest) {
    result += ` → ${colors.cyan}${latest}${colors.reset} (latest)`;
  }

  return result;
}

function main(): void {
  log('========================================', 'blue');
  log('  ECCB Dependency Check                ', 'blue');
  log('========================================', 'blue');

  const packageJson = getPackageJson();
  const outdatedPackages = getOutdatedPackages();
  const vulnerabilities = checkVulnerabilities();

  // Summary
  log('\n📦 Dependency Summary:', 'yellow');
  const prodDeps = Object.keys(packageJson.dependencies || {}).length;
  const devDeps = Object.keys(packageJson.devDependencies || {}).length;
  console.log(`  Production dependencies: ${prodDeps}`);
  console.log(`  Development dependencies: ${devDeps}`);
  console.log(`  Outdated packages: ${outdatedPackages.length}`);
  console.log(`  Vulnerabilities: ${vulnerabilities.count}`);

  // Vulnerability report
  if (vulnerabilities.count > 0) {
    log(`\n⚠️  Security: ${vulnerabilities.summary}`, 'red');
    log('  Run "pnpm audit" for details or "pnpm audit --fix" to fix', 'yellow');
  } else {
    log('\n✓ No known vulnerabilities', 'green');
  }

  // Outdated packages
  if (outdatedPackages.length > 0) {
    log('\n📋 Outdated Packages:', 'yellow');
    console.log('');

    // Group by update type
    const majorUpdates: OutdatedPackage[] = [];
    const minorUpdates: OutdatedPackage[] = [];
    const patchUpdates: OutdatedPackage[] = [];

    for (const pkg of outdatedPackages) {
      const currentMajor = parseInt(pkg.current.split('.')[0], 10);
      const latestMajor = parseInt(pkg.latest.split('.')[0], 10);

      if (currentMajor !== latestMajor) {
        majorUpdates.push(pkg);
      } else if (pkg.current !== pkg.wanted) {
        minorUpdates.push(pkg);
      } else {
        patchUpdates.push(pkg);
      }
    }

    if (majorUpdates.length > 0) {
      log('  🔴 Major Updates (Breaking Changes):', 'red');
      for (const pkg of majorUpdates) {
        const isProd = packageJson.dependencies?.[pkg.name];
        const type = isProd ? '[prod]' : '[dev]';
        console.log(`    ${type} ${pkg.name}: ${formatVersion(pkg.current, pkg.wanted, pkg.latest)}`);
      }
      console.log('');
    }

    if (minorUpdates.length > 0) {
      log('  🟡 Minor Updates (New Features):', 'yellow');
      for (const pkg of minorUpdates) {
        const isProd = packageJson.dependencies?.[pkg.name];
        const type = isProd ? '[prod]' : '[dev]';
        console.log(`    ${type} ${pkg.name}: ${formatVersion(pkg.current, pkg.wanted, pkg.latest)}`);
      }
      console.log('');
    }

    if (patchUpdates.length > 0) {
      log('  🟢 Patch Updates (Bug Fixes):', 'green');
      for (const pkg of patchUpdates) {
        const isProd = packageJson.dependencies?.[pkg.name];
        const type = isProd ? '[prod]' : '[dev]';
        console.log(`    ${type} ${pkg.name}: ${formatVersion(pkg.current, pkg.wanted, pkg.latest)}`);
      }
      console.log('');
    }

    // Recommendations
    log('📝 Recommendations:', 'cyan');
    console.log('  1. Run "pnpm update" to apply safe updates (within version ranges)');
    console.log('  2. Run "pnpm outdated" to see full details');
    console.log('  3. Review major updates carefully before updating');
    console.log('  4. Test thoroughly after updating dependencies');
    console.log('');
    log('🔧 Quick Commands:', 'cyan');
    console.log('  pnpm run deps:update    - Interactive update');
    console.log('  pnpm update             - Apply safe updates');
    console.log('  pnpm audit --fix        - Fix vulnerabilities');
    console.log('');

    // Exit with error if there are major updates or vulnerabilities
    if (majorUpdates.length > 0 || vulnerabilities.count > 0) {
      log('⚠️  Action required: Major updates or vulnerabilities found', 'yellow');
      process.exit(1);
    }
  } else {
    log('\n✓ All dependencies are up to date!', 'green');
  }
}

main();
