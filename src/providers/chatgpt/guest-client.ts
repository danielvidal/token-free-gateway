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

		const baselineBody = await page.evaluate(() => document.body?.innerText ?? "");

		await inputHandle.click();
		await page.waitForTimeout(250);
		await pasteText(page, params.message, inputHandle);
		await page.waitForTimeout(250);
		await page.keyboard.press("Enter");
		console.log(
			`[ChatGPT Guest] DOM: pasted message and pressed Enter (baseline body: ${baselineBody.length} chars)`,
		);

		const deadline = Date.now() + this.config.maxWaitMs;
		let lastText = "";
		let stableCount = 0;

		while (Date.now() < deadline) {
			if (params.signal?.aborted) throw new Error("ChatGPT guest request aborted");
			await page.waitForTimeout(this.config.pollIntervalMs);

			const result = await page.evaluate(
				({ baseline, prompt }) => {
					const normalizeLine = (text: string) =>
						text.replace(/[\u200B-\u200D\uFEFF]/g, "").replace(/\s+/g, " ").trim();
					const stopButton = document.querySelector(
						'button[data-testid="stop-button"], button[aria-label*="Stop" i], button[aria-label*="stop" i]',
					);
					const baselineLines = new Set(
						baseline
							.split("\n")
							.map(normalizeLine)
							.filter(Boolean),
					);
					const promptLine = normalizeLine(prompt);
					const bodyLines = (document.body?.innerText ?? "")
						.split("\n")
						.map(normalizeLine)
						.filter(Boolean);

					const noise = new Set([
						"ChatGPT",
						"Log in",
						"Sign up",
						"Attach",
						"Search",
						"Voice",
						"Send",
						"Copy",
						"Edit",
						"Good response",
						"Bad response",
						"Read aloud",
						"Regenerate",
					]);

					const newLines = bodyLines.filter((line) => {
						if (!line || line === promptLine) return false;
						if (baselineLines.has(line)) return false;
						if (noise.has(line)) return false;
						if (/^ChatGPT can make mistakes/i.test(line)) return false;
						return true;
					});

					if (newLines.length === 0) {
						return { text: "", isStreaming: !!stopButton, lineCount: 0 };
					}

					// The prompt itself is filtered above, so the remaining new body text is
					// the assistant response plus occasional controls. Preserve line breaks.
					return {
						text: newLines.join("\n").trim(),
						isStreaming: !!stopButton,
						lineCount: newLines.length,
					};
				},
				{ baseline: baselineBody, prompt: params.message },
			);

			if (result.text && result.text !== lastText) {
				lastText = result.text;
				stableCount = 0;
				console.log(
					`[ChatGPT Guest] captured ${lastText.length} chars from body diff (${result.lineCount} lines)${result.isStreaming ? " (streaming)" : ""}`,
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
			"ChatGPT guest: response appeared to be generated, but no assistant text could be captured from document.body.innerText.",
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
