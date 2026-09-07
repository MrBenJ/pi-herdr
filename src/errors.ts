import type { Failure } from "./contracts.ts";

export class HerdrToolError extends Error {
  readonly failure: Failure;

  constructor(failure: Failure) {
    super(JSON.stringify(failure));
    this.name = "HerdrToolError";
    this.failure = failure;
  }
}
