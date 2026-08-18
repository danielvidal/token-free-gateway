import type { ProviderDefinition } from "../types.ts";
import { loginPerplexityWeb } from "./auth.ts";
import { PerplexityWebClient } from "./client.ts";

export const definition: ProviderDefinition = {
	id: "perplexity-web",
	name: "Perplexity (Web)",
	authMode: "optional",
	models: [
		{ id: "perplexity-web", name: "Perplexity (Sonar)" },
		{ id: "perplexity-pro", name: "Perplexity Pro" },
	],
	factory: (credentials) => new PerplexityWebClient((credentials ?? { cookie: "" }) as any),
	loginFn: loginPerplexityWeb,
};
