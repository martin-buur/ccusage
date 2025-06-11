import type { CostMode, SortOrder } from './types.internal.ts';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { unreachable } from '@core/errorutil';
import { sort } from 'fast-sort';
import { glob } from 'tinyglobby';
import * as v from 'valibot';
import {
	PricingFetcher,
} from './pricing-fetcher.ts';
import { groupBy } from './utils.internal.ts';

export function getDefaultClaudePath(): string {
	return path.join(homedir(), '.claude');
}

export const UsageDataSchema = v.object({
	timestamp: v.string(),
	version: v.optional(v.string()), // Claude Code version
	message: v.object({
		usage: v.object({
			input_tokens: v.number(),
			output_tokens: v.number(),
			cache_creation_input_tokens: v.optional(v.number()),
			cache_read_input_tokens: v.optional(v.number()),
		}),
		model: v.optional(v.string()), // Model is inside message object
	}),
	costUSD: v.optional(v.number()), // Made optional for new schema
});

export type UsageData = v.InferOutput<typeof UsageDataSchema>;

export const DailyUsageSchema = v.object({
	date: v.pipe(
		v.string(),
		v.regex(/^\d{4}-\d{2}-\d{2}$/), // YYYY-MM-DD format
	),
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
});

export type DailyUsage = v.InferOutput<typeof DailyUsageSchema>;

export const SessionUsageSchema = v.object({
	sessionId: v.string(),
	projectPath: v.string(),
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
	lastActivity: v.string(),
	versions: v.array(v.string()), // List of unique versions used in this session
});

export type SessionUsage = v.InferOutput<typeof SessionUsageSchema>;

export const MonthlyUsageSchema = v.object({
	month: v.pipe(
		v.string(),
		v.regex(/^\d{4}-\d{2}$/), // YYYY-MM format
	),
	inputTokens: v.number(),
	outputTokens: v.number(),
	cacheCreationTokens: v.number(),
	cacheReadTokens: v.number(),
	totalCost: v.number(),
});

export type MonthlyUsage = v.InferOutput<typeof MonthlyUsageSchema>;

export function formatDate(dateStr: string): string {
	const date = new Date(dateStr);
	const year = date.getFullYear();
	const month = String(date.getMonth() + 1).padStart(2, '0');
	const day = String(date.getDate()).padStart(2, '0');
	return `${year}-${month}-${day}`;
}

export async function calculateCostForEntry(
	data: UsageData,
	mode: CostMode,
	fetcher: PricingFetcher,
): Promise<number> {
	if (mode === 'display') {
		// Always use costUSD, even if undefined
		return data.costUSD ?? 0;
	}

	if (mode === 'calculate') {
		// Always calculate from tokens
		if (data.message.model != null) {
			return fetcher.calculateCostFromTokens(data.message.usage, data.message.model);
		}
		return 0;
	}

	if (mode === 'auto') {
		// Auto mode: use costUSD if available, otherwise calculate
		if (data.costUSD != null) {
			return data.costUSD;
		}

		if (data.message.model != null) {
			return fetcher.calculateCostFromTokens(data.message.usage, data.message.model);
		}

		return 0;
	}

	unreachable(mode);
}

export type DateFilter = {
	since?: string; // YYYYMMDD format
	until?: string; // YYYYMMDD format
};

export type LoadOptions = {
	claudePath?: string; // Custom path to Claude data directory
	mode?: CostMode; // Cost calculation mode
	order?: SortOrder; // Sort order for dates
} & DateFilter;

export async function loadDailyUsageData(
	options?: LoadOptions,
): Promise<DailyUsage[]> {
	const claudePath = options?.claudePath ?? getDefaultClaudePath();
	const claudeDir = path.join(claudePath, 'projects');
	const files = await glob(['**/*.jsonl'], {
		cwd: claudeDir,
		absolute: true,
	});

	if (files.length === 0) {
		return [];
	}

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	// Use PricingFetcher with using statement for automatic cleanup
	using fetcher = mode === 'display' ? null : new PricingFetcher();

	// Collect all valid data entries first
	const allEntries: { data: UsageData; date: string; cost: number }[] = [];

	for (const file of files) {
		const content = await readFile(file, 'utf-8');
		const lines = content
			.trim()
			.split('\n')
			.filter(line => line.length > 0);

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as unknown;
				const result = v.safeParse(UsageDataSchema, parsed);
				if (!result.success) {
					continue;
				}
				const data = result.output;

				const date = formatDate(data.timestamp);
				// If fetcher is available, calculate cost based on mode and tokens
				// If fetcher is null, use pre-calculated costUSD or default to 0
				const cost = fetcher != null
					? await calculateCostForEntry(data, mode, fetcher)
					: data.costUSD ?? 0;

				allEntries.push({ data, date, cost });
			}
			catch {
				// Skip invalid JSON lines
			}
		}
	}

	// Group by date using Object.groupBy
	const groupedByDate = groupBy(allEntries, entry => entry.date);

	// Aggregate each group
	const results = Object.entries(groupedByDate)
		.map(([date, entries]) => {
			if (entries == null) {
				return undefined;
			}

			return entries.reduce(
				(acc, entry) => ({
					date,
					inputTokens:
						acc.inputTokens + (entry.data.message.usage.input_tokens ?? 0),
					outputTokens:
						acc.outputTokens + (entry.data.message.usage.output_tokens ?? 0),
					cacheCreationTokens:
						acc.cacheCreationTokens
						+ (entry.data.message.usage.cache_creation_input_tokens ?? 0),
					cacheReadTokens:
						acc.cacheReadTokens
						+ (entry.data.message.usage.cache_read_input_tokens ?? 0),
					totalCost: acc.totalCost + entry.cost,
				}),
				{
					date,
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				},
			);
		})
		.filter(item => item != null)
		.filter((item) => {
			// Filter by date range if specified
			if (options?.since != null || options?.until != null) {
				const dateStr = item.date.replace(/-/g, ''); // Convert to YYYYMMDD
				if (options.since != null && dateStr < options.since) {
					return false;
				}
				if (options.until != null && dateStr > options.until) {
					return false;
				}
			}
			return true;
		});

	// Sort by date based on order option (default to descending)
	const sortOrder = options?.order ?? 'desc';
	const sortedResults = sort(results);
	switch (sortOrder) {
		case 'desc':
			return sortedResults.desc(item => new Date(item.date).getTime());
		case 'asc':
			return sortedResults.asc(item => new Date(item.date).getTime());
		default:
			unreachable(sortOrder);
	}
}

export async function loadSessionData(
	options?: LoadOptions,
): Promise<SessionUsage[]> {
	const claudePath = options?.claudePath ?? getDefaultClaudePath();
	const claudeDir = path.join(claudePath, 'projects');
	const files = await glob(['**/*.jsonl'], {
		cwd: claudeDir,
		absolute: true,
	});

	if (files.length === 0) {
		return [];
	}

	// Fetch pricing data for cost calculation only when needed
	const mode = options?.mode ?? 'auto';

	// Use PricingFetcher with using statement for automatic cleanup
	using fetcher = mode === 'display' ? null : new PricingFetcher();

	// Collect all valid data entries with project info first
	const allEntries: Array<{
		data: UsageData;
		projectPath: string;
		cost: number;
		timestamp: Date;
	}> = [];

	for (const file of files) {
		// Extract project path from file path
		const relativePath = path.relative(claudeDir, file);
		const parts = relativePath.split(path.sep);

		// Project path is everything before the filename
		const joinedPath = parts.slice(0, -1).join(path.sep);
		const projectPath = joinedPath.length > 0 ? joinedPath : 'Unknown Project';

		const content = await readFile(file, 'utf-8');
		const lines = content
			.trim()
			.split('\n')
			.filter(line => line.length > 0);

		for (const line of lines) {
			try {
				const parsed = JSON.parse(line) as unknown;
				const result = v.safeParse(UsageDataSchema, parsed);
				if (!result.success) {
					continue;
				}
				const data = result.output;

				const cost = fetcher != null
					? await calculateCostForEntry(data, mode, fetcher)
					: data.costUSD ?? 0;

				allEntries.push({
					data,
					projectPath,
					cost,
					timestamp: new Date(data.timestamp),
				});
			}
			catch {
				// Skip invalid JSON lines
			}
		}
	}

	// Sort all entries by timestamp to group into sessions
	const sortedEntries = sort(allEntries).asc(entry => entry.timestamp.getTime());

	// Group entries into sessions based on 5-hour windows
	const sessionGroups: Array<typeof allEntries> = [];
	let currentSession: typeof allEntries = [];
	let sessionStartTime: Date | null = null;

	for (const entry of sortedEntries) {
		if (sessionStartTime === null) {
			// Start the first session
			sessionStartTime = entry.timestamp;
			currentSession = [entry];
		}
		else {
			// Check if this entry is within 5 hours of the session start
			const hoursDiff = (entry.timestamp.getTime() - sessionStartTime.getTime()) / (1000 * 60 * 60);

			if (hoursDiff <= 5) {
				// Add to current session
				currentSession.push(entry);
			}
			else {
				// Start a new session
				sessionGroups.push(currentSession);
				sessionStartTime = entry.timestamp;
				currentSession = [entry];
			}
		}
	}

	// Don't forget to add the last session
	if (currentSession.length > 0) {
		sessionGroups.push(currentSession);
	}

	// Aggregate each session group
	const results = sessionGroups
		.map((entries) => {
			if (entries.length === 0) {
				return undefined;
			}

			// Find the earliest and latest timestamps for session info
			const earliestEntry = entries[0];
			const latestEntry = entries[entries.length - 1];

			if (earliestEntry == null || latestEntry == null) {
				return undefined;
			}

			// Generate session ID based on start time
			const sessionId = `session-${earliestEntry.timestamp.toISOString().slice(0, 19).replace(/:/g, '-')}`;

			// Collect all unique project paths in this session
			const projectPaths = Array.from(new Set(entries.map(entry => entry.projectPath))).sort();
			const projectPath = projectPaths.length === 1 ? (projectPaths[0] ?? 'Unknown Project') : `Multiple (${projectPaths.length})`;

			// Collect all unique versions
			const versionSet = new Set<string>();
			for (const entry of entries) {
				if (entry.data.version != null) {
					versionSet.add(entry.data.version);
				}
			}

			// Aggregate totals
			const aggregated = entries.reduce(
				(acc, entry) => ({
					sessionId,
					projectPath,
					inputTokens:
						acc.inputTokens + (entry.data.message.usage.input_tokens ?? 0),
					outputTokens:
						acc.outputTokens + (entry.data.message.usage.output_tokens ?? 0),
					cacheCreationTokens:
						acc.cacheCreationTokens
						+ (entry.data.message.usage.cache_creation_input_tokens ?? 0),
					cacheReadTokens:
						acc.cacheReadTokens
						+ (entry.data.message.usage.cache_read_input_tokens ?? 0),
					totalCost: acc.totalCost + entry.cost,
					lastActivity: formatDate(latestEntry.timestamp.toISOString()),
					versions: Array.from(versionSet).sort(),
				}),
				{
					sessionId,
					projectPath,
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
					lastActivity: formatDate(latestEntry.timestamp.toISOString()),
					versions: Array.from(versionSet).sort(),
				},
			);

			return aggregated;
		})
		.filter(item => item != null)
		.filter((item) => {
			// Filter by date range if specified
			if (options?.since != null || options?.until != null) {
				const dateStr = item.lastActivity.replace(/-/g, ''); // Convert to YYYYMMDD
				if (options.since != null && dateStr < options.since) {
					return false;
				}
				if (options.until != null && dateStr > options.until) {
					return false;
				}
			}
			return true;
		});

	// Sort by last activity based on order option (default to descending)
	const sortOrder = options?.order ?? 'desc';
	const sortedResults = sort(results);
	return sortOrder === 'desc'
		? sortedResults.desc(item => new Date(item.lastActivity).getTime())
		: sortedResults.asc(item => new Date(item.lastActivity).getTime());
}

export async function loadMonthlyUsageData(
	options?: LoadOptions,
): Promise<MonthlyUsage[]> {
	const dailyData = await loadDailyUsageData(options);

	// Group daily data by month using Object.groupBy
	const groupedByMonth = groupBy(dailyData, data =>
		data.date.substring(0, 7));

	// Aggregate each month group
	const monthlyArray = Object.entries(groupedByMonth)
		.map(([month, dailyEntries]) => {
			if (dailyEntries == null) {
				return undefined;
			}

			return dailyEntries.reduce(
				(acc, data) => ({
					month,
					inputTokens: acc.inputTokens + data.inputTokens,
					outputTokens: acc.outputTokens + data.outputTokens,
					cacheCreationTokens:
						acc.cacheCreationTokens + data.cacheCreationTokens,
					cacheReadTokens: acc.cacheReadTokens + data.cacheReadTokens,
					totalCost: acc.totalCost + data.totalCost,
				}),
				{
					month,
					inputTokens: 0,
					outputTokens: 0,
					cacheCreationTokens: 0,
					cacheReadTokens: 0,
					totalCost: 0,
				},
			);
		})
		.filter(item => item != null);

	// Sort by month based on sortOrder
	const sortOrder = options?.order ?? 'desc';
	const sortedMonthly = sort(monthlyArray);
	return sortOrder === 'desc'
		? sortedMonthly.desc(item => item.month)
		: sortedMonthly.asc(item => item.month);
}
