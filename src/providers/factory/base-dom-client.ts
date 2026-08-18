import type { Page } from "playwright-core";
import type { BrowserCookie } from "../shared/cookie-parser.ts";
import { ensurePage } from "../shared/page-lifecycle.ts";
import { textToStream } from "../shared/stream-helpers.ts";
import type { ModelInfo, StreamResult, WebProviderClient } from "../types.ts";
import type { DomClientConfig, NormalizedSendParams } from "./types.ts";

/**
 * Abstract base class for DOM-interaction web providers (Gemini, GLM-Intl,
 * Perplexity, etc.).
 *
 * Subclasses implement `sendViaDom()` which handles input-finding, pasting
 * the message, pressing Enter, and polling for the response text.  The base
 * class provides a reusable `pollForStableText()` helper and takes care of
 * page lifecycle, stream wrapping, model listing, and cleanup.
 *
 * @typeParam TAuth - The credential shape returned by `getCredentials()`.
 */
export abstract class BaseDomClient<TAuth = unknown> implements WebProviderClient {
	abstract readonly providerId: string;
	protected abstract readonly config: DomClientConfig;

	protected page: Page | null = null;
	protected readonly auth: TAuth | undefined;

	constructor(auth?: TAuth) {
		this.auth = auth;
	}

	protected abstract getCookies(): BrowserCookie[];
	protected abstract sendViaDom(page: Page, params: NormalizedSendParams): Promise<string>;
	protected abstract parseStreamImpl(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult>;

	protected async onInit(): Promise<void> {}

	protected formatSsePayload(text: string): string {
		return `data: ${JSON.stringify({ text })}\n\n`;
	}

	async init(): Promise<void> {
		await this.getPage();
		await this.onInit();
	}

	async sendMessage(params: {
		message: string;
		model?: string;
		signal?: AbortSignal;
	}): Promise<ReadableStream<Uint8Array>> {
		const page = await this.getPage();
		const normalized: NormalizedSendParams = {
			message: params.message,
			model: params.model || this.config.models[0]?.id || "default",
			signal: params.signal,
		};

		const text = await this.sendViaDom(page, normalized);
		if (!text) {
			throw new Error(
				`${this.providerId}: no assistant reply detected. Ensure the site is reachable and guest access is available, or authenticate this provider.`,
			);
		}
		return textToStream(this.formatSsePayload(text));
	}

	async parseStream(
		body: ReadableStream<Uint8Array>,
		onDelta?: (delta: string) => void,
	): Promise<StreamResult> {
		return this.parseStreamImpl(body, onDelta);
	}

	listModels(): ModelInfo[] {
		return this.config.models;
	}

	async close(): Promise<void> {
		this.page = null;
	}

	protected async getPage(): Promise<Page> {
		this.page = await ensurePage(this.page, {
			hostKey: this.config.hostKey,
			startUrl: this.config.startUrl,
			cookies: this.getCookies(),
		});
		return this.page;
	}

	protected async pollForStableText(
		readText: () => Promise<string>,
		signal?: AbortSignal,
	): Promise<string> {
		let previous = "";
		let stableCount = 0;
		const deadline = Date.now() + this.config.maxWaitMs;
		while (Date.now() < deadline) {
			if (signal?.aborted) throw new Error(`${this.providerId}: request aborted`);
			const current = (await readText()).trim();
			if (current && current === previous) {
				stableCount += 1;
				if (stableCount >= this.config.stabilityThreshold) return current;
			} else {
				previous = current;
				stableCount = 0;
			}
			await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs));
		}
		if (previous) return previous;
		throw new Error(`${this.providerId}: timed out waiting for assistant response`);
	}
}
