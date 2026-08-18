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
		pollIntervalMs: 1500,
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

		return this.pollForStableText(async () => {
			return page.evaluate(() => {
				const clean = (text: string) => text.replace(/[\u200B-\u200D\uFEFF]/g, "").trim();
				const selectors = [
					'div[data-message-author-role="assistant"]',
					'.agent-turn [data-message-author-role="assistant"]',
					'[data-message-author-role="assistant"] [class*="markdown"]',
					'.agent-turn [class*="markdown"]',
				];
				for (const selector of selectors) {
					const elements = document.querySelectorAll(selector);
					if (elements.length === 0) continue;
					const last = elements[elements.length - 1] as HTMLElement;
					const text = clean(last.innerText ?? last.textContent ?? "");
					if (text) return text;
				}
				return "";
			});
		}, params.signal);
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
