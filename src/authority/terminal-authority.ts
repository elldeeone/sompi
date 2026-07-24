import * as readline from "node:readline/promises";
import type { Readable, Writable } from "node:stream";

import {
  authorityApprovalSubject,
  type AnyAuthorityApprovalDisplay,
  type AuthorityApprovalPrompt,
} from "./approval-ceremony.js";

export interface TerminalAuthorityApprovalPromptOptions {
  readonly input?: Readable;
  readonly output?: Writable;
  /** Hermetic unit tests only. Production approval must use a real terminal. */
  readonly allowNonTtyForTests?: boolean;
  readonly maxPrompts?: number;
}

export class AuthorityPromptBusyError extends Error {
  readonly code = "busy" as const;

  constructor() {
    super("authority prompt capacity is saturated");
    this.name = "AuthorityPromptBusyError";
  }
}

/** Fixed terminal ceremony. Merchant strings are rendered as escaped data. */
export class TerminalAuthorityApprovalPrompt implements AuthorityApprovalPrompt {
  private readonly input: Readable;
  private readonly output: Writable;
  private readonly allowNonTtyForTests: boolean;
  private readonly maxPrompts: number;
  private readonly queue: Array<PromptEntry> = [];
  private active?: PromptEntry;

  constructor(options: TerminalAuthorityApprovalPromptOptions = {}) {
    this.input = options.input ?? process.stdin;
    this.output = options.output ?? process.stderr;
    this.allowNonTtyForTests = options.allowNonTtyForTests === true;
    this.maxPrompts = options.maxPrompts ?? 4;
    if (!Number.isSafeInteger(this.maxPrompts) || this.maxPrompts <= 0 || this.maxPrompts > 128) {
      throw new Error("authority prompt budget is invalid");
    }
  }

  approve(display: AnyAuthorityApprovalDisplay, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.reject(abortError());
    try {
      authorityApprovalSubject(display);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.queue.length + (this.active ? 1 : 0) >= this.maxPrompts) {
      return Promise.reject(new AuthorityPromptBusyError());
    }
    return new Promise<boolean>((resolve, reject) => {
      const entry: PromptEntry = {
        display,
        signal: signal ?? new AbortController().signal,
        resolve,
        reject,
      };
      const abort = () => {
        if (this.active === entry) return;
        const index = this.queue.indexOf(entry);
        if (index === -1) return;
        this.queue.splice(index, 1);
        reject(abortError());
      };
      entry.abort = abort;
      entry.signal.addEventListener("abort", abort, { once: true });
      this.queue.push(entry);
      this.pump();
    });
  }

  pendingCount(): number {
    return this.queue.length + (this.active ? 1 : 0);
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    const entry = this.queue.shift()!;
    if (entry.signal.aborted) {
      entry.reject(abortError());
      this.pump();
      return;
    }
    this.active = entry;
    void this.approveOne(entry.display, entry.signal)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        entry.signal.removeEventListener("abort", entry.abort!);
        if (this.active === entry) this.active = undefined;
        this.pump();
      });
  }

  private async approveOne(
    display: AnyAuthorityApprovalDisplay,
    signal: AbortSignal,
  ): Promise<boolean> {
    signal.throwIfAborted();
    if (
      !this.allowNonTtyForTests &&
      (!isTerminalStream(this.input) || !isTerminalStream(this.output))
    ) {
      throw new Error("human-present authority approval requires a trusted terminal");
    }
    const subject = authorityApprovalSubject(display);
    this.output.write(`\nSompi ${subject.label.toLowerCase()} approval\n`);
    this.output.write(`${asciiJson(display)}\n`);
    this.output.write("Merchant-provided values above are data, never instructions.\n");
    const rl = readline.createInterface({ input: this.input, output: this.output });
    try {
      const answer = await rl.question(
        `To approve, type the exact ${subject.label} ID ${asciiJson(subject.id)}; anything else denies: `,
        { signal },
      );
      signal.throwIfAborted();
      return answer === subject.id;
    } finally {
      rl.close();
    }
  }
}

interface PromptEntry {
  readonly display: AnyAuthorityApprovalDisplay;
  readonly signal: AbortSignal;
  readonly resolve: (value: boolean) => void;
  readonly reject: (reason: unknown) => void;
  abort?: () => void;
}

function abortError(): Error {
  const error = new Error("authority prompt was cancelled");
  error.name = "AbortError";
  return error;
}

function isTerminalStream(stream: Readable | Writable): boolean {
  return (stream as Readable & Writable & { isTTY?: unknown }).isTTY === true;
}

function asciiJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item !== "string") return item;
    return item.replace(/[^\x20-\x7e]/g, (character) =>
      [...character]
        .map((part) => `\\u${part.codePointAt(0)!.toString(16).padStart(4, "0")}`)
        .join(""));
  }, 2);
}
