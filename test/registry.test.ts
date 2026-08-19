import { describe, expect, test } from "bun:test";
import { ModelNotPermittedError } from "../src/providers/types.ts";

describe("ModelNotPermittedError", () => {
	test("carries provider id and clean message", () => {
		const err = new ModelNotPermittedError("claude-web", "claude-sonnet-4-6");
		expect(err.name).toBe("ModelNotPermittedError");
		expect(err.providerId).toBe("claude-web");
		expect(err.message).toContain('Model "claude-sonnet-4-6" is not permitted');
		expect(err.message).toContain("claude-web");
	});

	test("supports custom message", () => {
		const err = new ModelNotPermittedError("grok-web", "grok-2", "custom blocked reason");
		expect(err.message).toBe("custom blocked reason");
	});

	test("defaults model name when omitted", () => {
		const err = new ModelNotPermittedError("deepseek-web");
		expect(err.message).toContain("this model");
		expect(err.message).toContain("deepseek-web");
	});
});
