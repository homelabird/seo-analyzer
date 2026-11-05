import { sanitizeForOutput } from '../sanitize.js';
import chalk from 'chalk';
import type { AuditResult, CategoryResult, RuleResult, RuleStatus } from '../types.js';
import { getCategoryById } from '../categories/index.js';
import {
  getLetterGrade,
  formatScoreWithGrade,
  renderCompactBar,
  getScoreColor,
  renderSeparator,
} from './banner.js';
import { isNotMeasured } from '../rules/define-rule.js';
import { collectFindings } from './findings.js';

/**
 * Grouped issue for display
 */
interface GroupedIssue {
  ruleId: string;
  ruleName: string;
  status: RuleStatus;
  message: string;
  /** Carried through so unmeasured checks can be labelled as such, not as warnings. */
  weight?: number;
  pages: string[];
  details: Array<{ key: string; value: string }>;
  /** Set once grouping is done; see the sort in `groupIssuesByCategory`. */
  priority: number;
  /** Pages the rule could be measured on, for the priority share */
  measuredPages: number;
  pageCount: number;
}

/**
 * Category with grouped issues
 */
interface CategoryIssues {
  categoryId: string;
  categoryName: string;
  errorCount: number;
  warningCount: number;
  /** Checks that took no reading; listed, but not counted as warnings. */
  notMeasuredCount: number;
  issues: GroupedIssue[];
}

/**
 * Group issues by category, rule, and message
 */
function groupIssuesByCategory(result: AuditResult): CategoryIssues[] {
  const categoryMap = new Map<string, CategoryIssues>();
  for (const finding of collectFindings(result)) {
    let category = categoryMap.get(finding.categoryId);
    if (!category) {
      category = { categoryId: finding.categoryId, categoryName: finding.categoryName, errorCount: 0, warningCount: 0, notMeasuredCount: 0, issues: [] };
      categoryMap.set(finding.categoryId, category);
    }
    if (finding.status === 'fail') category.errorCount++;
    else if (finding.status === 'warn') category.warningCount++;
    else category.notMeasuredCount++;
    category.issues.push({
      ...finding,
      details: Object.entries(finding.details ?? {}).filter(([key]) => key !== 'pageUrl' && key !== 'url')
        .map(([key, value]) => ({ key, value: typeof value === 'object' ? JSON.stringify(value) : String(value) })),
    });
  }
  const categories = [...categoryMap.values()].sort((a, b) => b.errorCount - a.errorCount || b.warningCount - a.warningCount);

  return categories;
}

/**
 * Render pages list with "+N more" truncation
 */
function renderPagesList(pages: string[], maxItems = 5, indent = '      '): void {
  const displayPages = pages.slice(0, maxItems);

  for (const page of displayPages) {
    // Simplify URL for display
    let displayUrl = page;
    try {
      const url = new URL(page);
      displayUrl = url.pathname || '/';
    } catch {
      // Keep original if not a valid URL
    }
    console.log(chalk.gray(`${indent}→ ${displayUrl}`));
  }

  if (pages.length > maxItems) {
    console.log(chalk.gray(`${indent}... +${pages.length - maxItems} more`));
  }
}

/**
 * Render details list with truncation
 */
function renderDetailsList(details: Array<{ key: string; value: string }>, maxItems = 5, indent = '      '): void {
  const displayDetails = details.slice(0, maxItems);

  for (const { key, value } of displayDetails) {
    // Truncate long values
    const truncated = value.length > 60 ? value.substring(0, 57) + '...' : value;
    console.log(chalk.gray(`${indent}→ ${truncated}`));
  }

  if (details.length > maxItems) {
    console.log(chalk.gray(`${indent}... +${details.length - maxItems} more`));
  }
}

/**
 * Render the terminal report for an audit result
 * @param result - The audit result to render
 */
export function renderTerminalReport(result: AuditResult): void {
  result = sanitizeForOutput(result);
  console.log();

  // Report header
  console.log(renderSeparator(50));
  console.log(chalk.bold('SEOMATOR REPORT'));

  // URL, pages, and score in one line
  const domain = extractDomain(result.url);
  const pageInfo = result.crawledPages > 1 ? `${result.crawledPages} pages` : '1 page';
  console.log(
    `${chalk.white(domain)} ${chalk.gray('•')} ${chalk.gray(pageInfo)} ${chalk.gray('•')} ${formatScoreWithGrade(result.measured === false ? null : result.overallScore)}`
  );
  console.log(renderSeparator(50));
  console.log();

  // Health Score
  const { grade, color } = getLetterGrade(result.measured === false ? null : result.overallScore);
  console.log(`${chalk.bold('Health Score:')} ${result.measured === false ? color('N/A (not measured)') : color(`${result.overallScore}/100 (${grade})`)}`);
  // A capped score above category bars in the 90s reads as a bug unless the
  // reason sits directly under the number it explains.
  if (result.scoreCap) {
    console.log(chalk.gray(`  Capped from ${result.scoreCap.uncappedScore}, the category average:`));
    for (const cap of result.scoreCap.caps) {
      console.log(chalk.gray(`  • ${cap.reason}`));
    }
  }
  // A staging audit scores as if live; what it waived is the launch list.
  if (result.waivedCaps) {
    console.log(chalk.gray('  Waived for staging, would cap the score in production:'));
    for (const cap of result.waivedCaps) {
      console.log(chalk.gray(`  • ${cap.reason} (cap ${cap.ceiling})`));
    }
  }
  console.log();

  for (const reason of result.coverage?.unavailableMeasurements ?? []) console.log(chalk.gray(`  Not measured: ${reason}`));

  // Category Breakdown
  console.log(chalk.bold('Category Breakdown:'));
  console.log(chalk.gray('-'.repeat(50)));

  // Sort categories by score (worst first for priority)
  const sortedCategories = [...result.categoryResults].sort((a, b) => a.score - b.score);

  for (const categoryResult of sortedCategories) {
    const category = getCategoryById(categoryResult.categoryId);
    const categoryName = category?.name ?? categoryResult.categoryId;
    const scoreColor = getScoreColor(categoryResult.measured === false ? null : categoryResult.score);
    const bar = renderCompactBar(categoryResult.score);

    // Category name and progress bar
    console.log(
      `${categoryName.padEnd(20)} ${scoreColor(bar)} ${scoreColor(categoryResult.measured === false ? 'N/A' : `${categoryResult.score}%`)}`
    );

    // Pass/warn/fail counts on second line
    const passStr = chalk.green(`Passed: ${categoryResult.passCount}`);
    const warnStr = categoryResult.warnCount > 0
      ? chalk.yellow(` | Warnings: ${categoryResult.warnCount}`)
      : '';
    const failStr = categoryResult.failCount > 0
      ? chalk.red(` | Failed: ${categoryResult.failCount}`)
      : '';
    const notMeasured = categoryResult.notMeasuredCount ?? 0;
    const skipStr = notMeasured > 0
      ? chalk.gray(` | Not measured: ${notMeasured}`)
      : '';
    console.log(`  ${passStr}${warnStr}${failStr}${skipStr}`);
  }

  console.log();

  // Calculate totals
  const totalPassed = result.categoryResults.reduce((sum, cat) => sum + cat.passCount, 0);
  const totalWarnings = result.categoryResults.reduce((sum, cat) => sum + cat.warnCount, 0);
  const totalFailures = result.categoryResults.reduce((sum, cat) => sum + cat.failCount, 0);
  const totalNotMeasured = result.categoryResults.reduce(
    (sum, cat) => sum + (cat.notMeasuredCount ?? 0),
    0
  );

  const totalSkipStr = totalNotMeasured > 0 ? `, ${totalNotMeasured} not measured` : '';
  console.log(
    chalk.gray(
      `Total: ${totalPassed} passed, ${totalWarnings} warnings, ${totalFailures} errors${totalSkipStr}`
    )
  );
  console.log();

  // Grouped Issues
  const groupedIssues = groupIssuesByCategory(result);

  if (groupedIssues.length > 0) {
    console.log(chalk.bold('ISSUES'));
    console.log();

    for (const categoryIssues of groupedIssues) {
      // Category header with counts
      const errorPart = categoryIssues.errorCount > 0
        ? chalk.red(`${categoryIssues.errorCount} errors`)
        : '';
      const warningPart = categoryIssues.warningCount > 0
        ? chalk.yellow(`${categoryIssues.warningCount} warnings`)
        : '';
      const notMeasuredPart = categoryIssues.notMeasuredCount > 0
        ? chalk.gray(`${categoryIssues.notMeasuredCount} not measured`)
        : '';
      const header = [errorPart, warningPart, notMeasuredPart].filter(Boolean).join(', ');

      console.log(chalk.bold(`${categoryIssues.categoryName}`) + chalk.gray(` (${header})`));

      for (const issue of categoryIssues.issues) {
        // Issue type indicator
        const typeLabel = issue.status === 'fail'
          ? chalk.red('(error)')
          : isNotMeasured(issue)
            ? chalk.gray('(not measured)')
            : chalk.yellow('(warning)');

        // Rule ID and name
        console.log(`  ${chalk.gray(issue.ruleId)} ${issue.ruleName} ${typeLabel}`);

        // Status icon and message. Three states, not two: a check that took no
        // reading was drawn with the same yellow warning triangle as a real
        // warning, one line under a label reading "(not measured)".
        const icon = issue.status === 'fail'
          ? chalk.red('✗')
          : isNotMeasured(issue)
            ? chalk.gray('–')
            : chalk.yellow('⚠');
        const pageCount = issue.pageCount > 1 ? ` (${issue.pageCount} pages)` : '';
        console.log(`    ${icon} ${issue.ruleId}: ${issue.message}${chalk.gray(pageCount)}`);

        // Show affected pages
        if (issue.pages.length > 0) {
          renderPagesList(issue.pages, 5, '      ');
        }

        // Show other details
        if (issue.details.length > 0 && issue.pages.length === 0) {
          renderDetailsList(issue.details, 5, '      ');
        }
      }
      console.log();
    }
  }

  // Summary footer. Carries the not-measured count too: without it the closing
  // line read "217 passed • 34 warnings • 24 failed" for a 332-rule audit, and
  // the 57 checks that never ran simply vanished from the last thing the user
  // sees. The HTML report has always shown all four numbers.
  console.log(renderSeparator(50));
  console.log(
    `${chalk.green(`${totalPassed} passed`)} ${chalk.gray('•')} ` +
    `${chalk.yellow(`${totalWarnings} warnings`)} ${chalk.gray('•')} ` +
    `${chalk.red(`${totalFailures} failed`)}` +
    (totalNotMeasured > 0
      ? ` ${chalk.gray('•')} ${chalk.gray(`${totalNotMeasured} not measured`)}`
      : '')
  );
  console.log(renderSeparator(50));
  console.log();
}

/**
 * Extract domain from URL
 */
function extractDomain(url: string): string {
  try {
    const parsed = new URL(url.startsWith('http') ? url : `https://${url}`);
    return parsed.hostname;
  } catch {
    return url;
  }
}
