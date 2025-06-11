import process from 'node:process';
import Table from 'cli-table3';
import { define } from 'gunshi';
import pc from 'picocolors';
import {
	calculateTotals,
	createTotalsObject,
	getTotalTokens,
} from '../calculate-cost.ts';
import { loadSessionData } from '../data-loader.ts';
import { detectMismatches, printMismatchReport } from '../debug.ts';
import { log, logger } from '../logger.ts';
import { sharedCommandConfig } from '../shared-args.internal.ts';
import { formatCurrency, formatNumber } from '../utils.internal.ts';

export const sessionCommand = define({
	name: 'session',
	description: 'Show usage report grouped by conversation session',
	...sharedCommandConfig,
	async run(ctx) {
		if (ctx.values.json) {
			logger.level = 0;
		}

		const sessionData = await loadSessionData({
			since: ctx.values.since,
			until: ctx.values.until,
			claudePath: ctx.values.path,
			mode: ctx.values.mode,
			order: ctx.values.order,
		});

		if (sessionData.length === 0) {
			if (ctx.values.json) {
				log(JSON.stringify([]));
			}
			else {
				logger.warn('No Claude usage data found.');
			}
			process.exit(0);
		}

		// Calculate totals
		const totals = calculateTotals(sessionData);

		// Show debug information if requested
		if (ctx.values.debug && !ctx.values.json) {
			const mismatchStats = await detectMismatches(ctx.values.path);
			printMismatchReport(mismatchStats, ctx.values.debugSamples);
		}

		if (ctx.values.json) {
			// Output JSON format
			const jsonOutput = {
				sessions: sessionData.map((data) => {
					const sessionStartISO = data.sessionId.replace('session-', '');
					// Convert from session-2025-06-09T14-50-32 format to proper ISO UTC
					const properISO = sessionStartISO.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3Z');
					const sessionStartDate = new Date(properISO);
					return {
						projectPath: data.projectPath,
						sessionId: data.sessionId,
						sessionStart: properISO,
						sessionStartLocal: sessionStartDate.toLocaleString('en-US', {
							month: 'numeric',
							day: 'numeric',
							year: 'numeric',
							hour: 'numeric',
							minute: '2-digit',
							second: '2-digit',
							hour12: true,
							timeZoneName: 'short',
						}),
						inputTokens: data.inputTokens,
						outputTokens: data.outputTokens,
						cacheCreationTokens: data.cacheCreationTokens,
						cacheReadTokens: data.cacheReadTokens,
						totalTokens: getTotalTokens(data),
						totalCost: data.totalCost,
						lastActivity: data.lastActivity,
					};
				}),
				totals: createTotalsObject(totals),
			};
			log(JSON.stringify(jsonOutput, null, 2));
		}
		else {
			// Print header
			logger.box('Claude Code Token Usage Report - By Session');

			// Create table
			const table = new Table({
				head: [
					'Session Start',
					'Input',
					'Output',
					'Cache Create',
					'Cache Read',
					'Total Tokens',
					'Cost (USD)',
					'Last Activity',
				],
				style: {
					head: ['cyan'],
				},
				colAligns: [
					'left',
					'right',
					'right',
					'right',
					'right',
					'right',
					'right',
					'left',
				],
			});

			let maxSessionLength = 0;
			for (const data of sessionData) {
				const sessionStartISO = data.sessionId.replace('session-', '');
				// Convert from session-2025-06-09T14-50-32 format to proper ISO UTC
				const properISO = sessionStartISO.replace(/T(\d{2})-(\d{2})-(\d{2})/, 'T$1:$2:$3Z');
				const sessionStartDate = new Date(properISO);
				const sessionDisplay = sessionStartDate.toLocaleString('en-US', {
					month: 'numeric',
					day: 'numeric',
					year: 'numeric',
					hour: 'numeric',
					minute: '2-digit',
					second: '2-digit',
					hour12: true,
					timeZoneName: 'short',
				});

				maxSessionLength = Math.max(maxSessionLength, sessionDisplay.length);

				table.push([
					sessionDisplay,
					formatNumber(data.inputTokens),
					formatNumber(data.outputTokens),
					formatNumber(data.cacheCreationTokens),
					formatNumber(data.cacheReadTokens),
					formatNumber(getTotalTokens(data)),
					formatCurrency(data.totalCost),
					data.lastActivity,
				]);
			}

			// Add separator
			table.push([
				'─'.repeat(maxSessionLength), // For Session Start
				'─'.repeat(12), // For Input Tokens
				'─'.repeat(12), // For Output Tokens
				'─'.repeat(12), // For Cache Create
				'─'.repeat(12), // For Cache Read
				'─'.repeat(12), // For Total Tokens
				'─'.repeat(10), // For Cost
				'─'.repeat(12), // For Last Activity
			]);

			// Add totals
			table.push([
				pc.yellow('Total'),
				pc.yellow(formatNumber(totals.inputTokens)),
				pc.yellow(formatNumber(totals.outputTokens)),
				pc.yellow(formatNumber(totals.cacheCreationTokens)),
				pc.yellow(formatNumber(totals.cacheReadTokens)),
				pc.yellow(formatNumber(getTotalTokens(totals))),
				pc.yellow(formatCurrency(totals.totalCost)),
				'',
			]);

			log(table.toString());
		}
	},
});
