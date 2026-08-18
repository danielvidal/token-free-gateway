import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BaseDomClient } from "../factory/base-dom-client.ts";
import type { DomClientConfig, NormalizedSendParams } from "../factory/types.ts";
import type { StreamResult } from "../types.ts";
import { parseChatGPTStream } from "./stream.ts";

const RESPONSE_SELECTORS = [
	'[data-message-author-role="assistant"]',
	'[data-testid^="conversation-turn-"]',
	'article[data-testid^="conversation-turn-"]',
	'.agent-turn',
	'[class*="markdown"]',
	'[class*="prose"]',
	'div[dir="auto"]',
	'p',
	'pre',
	'code',
] as const;

export class ChatGPTGuestClient extends BaseDomClient<Record<string, never>> {
	readonly providerId = "chatgpt-web";

	protected readonly config: DomClientConfig = {
		hostKey: "chatgpt.com",
		startUrl: "https://chatgpt.com/",
		cookieDomain: ".chatgpt.com",
		models: [
			{ id: "gpt-4", name: "GPT-4" },
			{ id: "gpt-4-turbo", name: "GPT-4 Turbo" },
			{ id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
		],
		pollIntervalMs: 750,
		maxWaitMs: 90_000,
		stabilityThreshold: 2,
	};

	constructor() {
		super({});
	}

	protected getCookies() {
		return [];
	}

	protected async sendViaDom(page: Page, params: NormalizedSendParams): Promise<string> {
		const inputSelectors = [
			"#prompt-textarea",
			"textarea[placeholder]",
			"textarea",
			'[contenteditable="true"]',
		];

		let inputHandle = null;
		for (const selector of inputSelectors) {
			inputHandle = await page.$(selector);
			if (inputHandle) break;
		}
		if (!inputHandle) {
			throw new Error(
				"ChatGPT guest: chat input not found. Guest access may be unavailable or the page may require interaction.",
			);
		}

		const baseline = await page.evaluate((selectors) => {
			const clean = (text: string) =>
				text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
			const texts = new Set<string>();
			for (const selector of selectors) {
				for (const element of document.querySelectorAll(selector)) {
					const el = element as HTMLElement;
					if (!el.offsetParent) continue;
					const text = clean(el.innerText ?? el.textContent ?? "");
					if (text) texts.add(text);
				}
			}
			return [...texts];
		}, [...RESPONSE_SELECTORS]);

		await inputHandle.click();
		await page.waitForTimeout(250);
		await pasteText(page, params.message, inputHandle);
		await page.waitForTimeout(250);
		await page.keyboard.press("Enter");
		console.log(
			`[ChatGPT Guest] DOM: pasted message and pressed Enter (baseline texts: ${baseline.length})`,
		);

		const baselineTexts = new Set(baseline);
		const deadline = Date.now() + this.config.maxWaitMs;
		let lastText = "";
		let stableCount = 0;

		while (Date.now() < deadline) {
			if (params.signal?.aborted) throw new Error("ChatGPT guest request aborted");
			await page.waitForTimeout(this.config.pollIntervalMs);

			const result = await page.evaluate(
				({ selectors, baseline, prompt }) => {
					const clean = (text: string) =>
						text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
					const normalizedPrompt = clean(prompt);
					const baselineSet = new Set(baseline);
					const stopButton = document.querySelector(
						'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="stop" i]',
					);

					const isNoise = (text: string) => {
						const lower = text.toLowerCase();
						return (
							!text ||
							text === normalizedPrompt ||
							baselineSet.has(text) ||
							lower === "chatgpt" ||
							lower === "log in" ||
							lower === "sign up" ||
							lower === "attach" ||
							lower === "search" ||
							lower === "voice" ||
							lower === "send" ||
							lower.startsWith("chatgpt can make mistakes")
						);
					};

					const candidates: Array<{ text: string; source: string; depth: number }> = [];
					for (const selector of selectors) {
						const elements = document.querySelectorAll(selector);
						for (let i = 0; i < elements.length; i++) {
							const el = elements[i] as HTMLElement;
							if (!el.offsetParent) continue;
							const text = clean(el.innerText ?? el.textContent ?? "");
							if (isNoise(text)) continue;
							let depth = 0;
							let cursor: Element | null = el;
							while (cursor?.parentElement) {
								depth++;
								cursor = cursor.parentElement;
							}
							candidates.push({ text, source: selector, depth });
						}
					}

					if (candidates.length === 0) {
						return { text: "", isStreaming: !!stopButton, source: "none", candidateCount: 0 };
					}

					// Prefer the deepest/newest DOM text. This avoids returning a large container
					// that includes both the prompt and the assistant response.
					candidates.sort((a, b) => a.depth - b.depth);
					const best = candidates[candidates.length - 1];
					return {
						text: best.text,
						isStreaming: !!stopButton,
						source: best.source,
						candidateCount: candidates.length,
					};
				},
				{
					selectors: [...RESPONSE_SELECTORS],
					baseline,
					prompt: params.message,
				},
			);

			if (result.text && result.text !== lastText) {
				lastText = result.text;
				stableCount = 0;
				console.log(
					`[ChatGPT Guest] captured ${lastText.length} chars via ${result.source} (${result.candidateCount} candidates)${result.isStreaming ? " (streaming)" : ""}`,
				);
			} else if (result.text) {
				stableCount += 1;
				if (!result.isStreaming && stableCount >= this.config.stabilityThreshold) {
					return result.text;
				}
			}
		}

		if (lastText) return lastText;
		throw new Error(
			"ChatGPT guest: response appeared to be generated, but no assistant text could be captured from the DOM.",
		);
	}

	protected override formatSsePayload(text: string): string {
		return `data: ${JSON.stringify({ message: { id: "guest-dom", content: { parts: [text] } } })}\n\ndata: [DONE]\n\n`;
	}

	protected parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return parseChatGPTStream(body, onDelta);
	}

	async checkSession(): Promise<{ valid: boolean; reason?: string }> {
		return { valid: true, reason: "guest" };
	}
}
