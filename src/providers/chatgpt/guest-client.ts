import type { Page } from "playwright-core";
import { pasteText } from "../../browser/dom-input.ts";
import { BaseDomClient } from "../factory/base-dom-client.ts";
import type { DomClientConfig, NormalizedSendParams } from "../factory/types.ts";
import type { StreamResult } from "../types.ts";
import { parseChatGPTStream } from "./stream.ts";

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
		pollIntervalMs: 1000,
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

		const baseline = await page.evaluate(() => {
			const turnSelectors = [
				'article[data-testid^="conversation-turn-"]',
				'[data-testid^="conversation-turn-"]',
				'article',
			];
			for (const selector of turnSelectors) {
				const count = document.querySelectorAll(selector).length;
				if (count > 0) return { selector, count };
			}
			return { selector: 'article[data-testid^="conversation-turn-"]', count: 0 };
		});

		await inputHandle.click();
		await page.waitForTimeout(250);
		await pasteText(page, params.message, inputHandle);
		await page.waitForTimeout(250);
		await page.keyboard.press("Enter");
		console.log(
			`[ChatGPT Guest] DOM: pasted message and pressed Enter (baseline turns: ${baseline.count})`,
		);

		const deadline = Date.now() + this.config.maxWaitMs;
		let lastText = "";
		let stableCount = 0;

		while (Date.now() < deadline) {
			if (params.signal?.aborted) throw new Error("ChatGPT guest request aborted");
			await page.waitForTimeout(this.config.pollIntervalMs);

			const result = await page.evaluate(
				({ baselineSelector, baselineCount, prompt }) => {
					const clean = (text: string) =>
						text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();

					const stopButton = document.querySelector(
						'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="stop" i]',
					);

					const assistantSelectors = [
						'[data-message-author-role="assistant"]',
						'div[data-message-author-role="assistant"]',
						'.agent-turn [data-message-author-role="assistant"]',
					];
					for (const selector of assistantSelectors) {
						const elements = document.querySelectorAll(selector);
						if (elements.length === 0) continue;
						const last = elements[elements.length - 1] as HTMLElement;
						const text = clean(last.innerText ?? last.textContent ?? "");
						if (text && text !== clean(prompt)) {
							return { text, isStreaming: !!stopButton, source: selector };
						}
					}

					const turns = document.querySelectorAll(baselineSelector);
					if (turns.length > baselineCount) {
						for (let i = turns.length - 1; i >= baselineCount; i--) {
							const turn = turns[i] as HTMLElement;
							const text = clean(turn.innerText ?? turn.textContent ?? "");
							if (text && text !== clean(prompt)) {
								return { text, isStreaming: !!stopButton, source: baselineSelector };
							}
						}
					}

					const genericTurns = document.querySelectorAll(
						'article[data-testid^="conversation-turn-"], [data-testid^="conversation-turn-"]',
					);
					for (let i = genericTurns.length - 1; i >= 0; i--) {
						const turn = genericTurns[i] as HTMLElement;
						const text = clean(turn.innerText ?? turn.textContent ?? "");
						if (text && text !== clean(prompt)) {
							return { text, isStreaming: !!stopButton, source: "conversation-turn" };
						}
					}

					return { text: "", isStreaming: !!stopButton, source: "none" };
				},
				{
					baselineSelector: baseline.selector,
					baselineCount: baseline.count,
					prompt: params.message,
				},
			);

			if (result.text && result.text !== lastText) {
				lastText = result.text;
				stableCount = 0;
				console.log(
					`[ChatGPT Guest] captured ${lastText.length} chars via ${result.source}${result.isStreaming ? " (streaming)" : ""}`,
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
