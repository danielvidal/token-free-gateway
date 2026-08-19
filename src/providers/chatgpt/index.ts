import type { ProviderDefinition } from "../types.ts";
import type { ChatGPTWebAuth } from "./auth.ts";
import { loginChatGPTWeb } from "./auth.ts";
import { ChatGPTWebClient } from "./client.ts";
import { ChatGPTGuestClient } from "./guest-client.ts";

export const definition: ProviderDefinition = {
	id: "chatgpt-web",
	name: "ChatGPT Web",
	authMode: "optional",
	models: [
		{ id: "gpt-4", name: "GPT-4" },
		{ id: "gpt-4-turbo", name: "GPT-4 Turbo" },
		{ id: "gpt-3.5-turbo", name: "GPT-3.5 Turbo" },
	],
	factory: (credentials) =>
		credentials ? new ChatGPTWebClient(credentials as ChatGPTWebAuth) : new ChatGPTGuestClient(),
	loginFn: loginChatGPTWeb,
};
