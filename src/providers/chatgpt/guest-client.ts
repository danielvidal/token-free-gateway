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

		await inputHandle.click();
		await page.waitForTimeout(250);
		await pasteText(page, params.message, inputHandle);
		await page.waitForTimeout(250);
		await page.keyboard.press("Enter");
		console.log("[ChatGPT Guest] DOM: pasted message and pressed Enter");

		const deadline = Date.now() + this.config.maxWaitMs;
		let lastText = "";
		let stableCount = 0;

		while (Date.now() < deadline) {
			if (params.signal?.aborted) throw new Error("ChatGPT guest request aborted");
			await page.waitForTimeout(this.config.pollIntervalMs);

			const result = await page.evaluate((prompt) => {
				const clean = (text: string) =>
					text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
				const promptText = clean(prompt);
				const humanPromptText = clean(`Human: ${prompt}`);
				const root = document.querySelector("main") ?? document.body;
				const stopButton = document.querySelector(
					'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="stop" i]',
				);

				const isVisible = (el: HTMLElement) => {
					const style = getComputedStyle(el);
					const rect = el.getBoundingClientRect();
					return (
						style.display !== "none" &&
						style.visibility !== "hidden" &&
						rect.width > 0 &&
						rect.height > 0
					);
				};

				const isNoise = (text: string) => {
					const value = clean(text);
					const lower = value.toLowerCase();
					return (
						!value ||
						value === promptText ||
						value === humanPromptText ||
						lower === "chatgpt" ||
						lower === "log in" ||
						lower.startsWith("sign up") ||
						lower === "copy" ||
						lower === "share" ||
						lower === "edit" ||
						lower === "read aloud" ||
						lower === "good response" ||
						lower === "bad response" ||
						lower.startsWith("you’ll get smarter responses") ||
						lower.startsWith("you'll get smarter responses") ||
						lower.startsWith("chatgpt can make mistakes")
					);
				};

				const all = Array.from(root.querySelectorAll<HTMLElement>("*"));
				const promptMatches = all.filter((el) => {
					if (!isVisible(el)) return false;
					const text = clean(el.innerText ?? el.textContent ?? "");
					return text === promptText || text === humanPromptText;
				});

				// Prefer the smallest matching element so we anchor on the prompt bubble,
				// not on a large conversation container that happens to include it.
				promptMatches.sort((a, b) => a.querySelectorAll("*").length - b.querySelectorAll("*").length);
				const promptEl = promptMatches[0];

				if (promptEl) {
					const afterPrompt = all.filter((el) => {
						if (!isVisible(el) || el === promptEl || promptEl.contains(el)) return false;
						const relation = promptEl.compareDocumentPosition(el);
						if (!(relation & Node.DOCUMENT_POSITION_FOLLOWING)) return false;
						if (el.closest("header, nav, form, button, [role='dialog']")) return false;
						const text = clean(el.innerText ?? el.textContent ?? "");
						if (isNoise(text)) return false;
						// Leaf-ish elements are much less likely to be a page-level banner/container.
						const visibleChildren = Array.from(el.children).filter((child) =>
							isVisible(child as HTMLElement),
						).length;
						return visibleChildren <= 2;
					});

					const first = afterPrompt[0];
					if (first) {
						let best = first;
						let cursor = first.parentElement;
						while (cursor && cursor !== root && cursor !== document.body) {
							const text = clean(cursor.innerText ?? cursor.textContent ?? "");
							if (!text || isNoise(text)) break;
							if (text.includes(promptText) || text.includes(humanPromptText)) break;
							if (cursor.matches("header, nav, form, [role='dialog']")) break;
							// Keep climbing while the container still looks like one assistant turn.
							if (text.length > 20_000) break;
							best = cursor;
							cursor = cursor.parentElement;
						}

						let text = clean(best.innerText ?? best.textContent ?? "");
						text = text
							.replace(/\b(Copy|Share|Read aloud|Good response|Bad response|Regenerate)\b/gi, " ")
							.replace(/\s+/g, " ")
							.trim();
						if (!isNoise(text)) {
							return { text, isStreaming: !!stopButton, source: "after-prompt" };
						}
					}
				}

				// Fallback: the guest UI renders a Copy action under each assistant turn.
				// Walk up from the last Copy button until we find a non-trivial text container.
				const copyButtons = Array.from(
					document.querySelectorAll<HTMLElement>(
						'button[aria-label*="Copy" i], button[title*="Copy" i], [data-testid*="copy" i]',
					),
				).filter(isVisible);
				const copyButton = copyButtons[copyButtons.length - 1];
				if (copyButton) {
					let cursor: HTMLElement | null = copyButton.parentElement;
					while (cursor && cursor !== root && cursor !== document.body) {
						let text = clean(cursor.innerText ?? cursor.textContent ?? "");
						text = text
							.replace(/\b(Copy|Share|Read aloud|Good response|Bad response|Regenerate)\b/gi, " ")
							.replace(/\s+/g, " ")
							.trim();
						if (!isNoise(text) && !text.includes(promptText) && !text.includes(humanPromptText)) {
							return { text, isStreaming: !!stopButton, source: "copy-action" };
						}
						cursor = cursor.parentElement;
					}
				}

				return { text: "", isStreaming: !!stopButton, source: "none" };
			}, params.message);

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
			"ChatGPT guest: assistant replied in the browser, but the response block could not be extracted.",
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
