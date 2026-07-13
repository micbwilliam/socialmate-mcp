import { z } from 'zod';

import { buildHumanAgentPrompt } from './prompt-text.mjs';

// Re-exported so existing importers (and the parity test's old path) keep working.
export { buildHumanAgentPrompt };

/** @type {Array<{name:string,config:object,build:(a:object)=>string}>} */
export const PROMPTS = [
	{
		name: 'socialmate_human_agent',
		config: {
			title: 'WhatsApp agent that behaves like a human',
			description:
				'A production system prompt for an AI agent operating a real WhatsApp number through SocialMate. Teaches the human reply cadence (mark read → recall → typing → react or reply), the full tool inventory and when NOT to use each, the tier and anti-ban error contract (402 / 429 / queueable:false / signal_rate_limit), what the agent genuinely cannot do, and the consent and honesty rules. Fill in your business details.',
			argsSchema: {
				business_name: z.string().optional().describe('The business the agent represents, e.g. "Northwind Coffee".'),
				business_description: z.string().optional().describe('One clause describing the business, e.g. "specialty coffee roastery in Cairo".'),
				agent_name: z.string().optional().describe('The name the agent goes by. Defaults to the business name.'),
				agent_role: z.string().optional().describe('e.g. "front-desk support", "sales qualification", "booking".'),
				tone: z.string().optional().describe('e.g. "warm, concise, never salesy".'),
				business_hours: z.string().optional().describe('e.g. "Sun–Thu, 9:00–17:00 Cairo time".'),
				escalation_procedure: z.string().optional().describe('How the agent hands off to a human.'),
				scope_boundaries: z.string().optional().describe('What the agent may answer on its own.'),
				additional_rules: z.string().optional().describe('Any extra house rule to append to the judgement section.'),
			},
		},
		build: buildHumanAgentPrompt,
	},
];
