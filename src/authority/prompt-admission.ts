export class AuthorityPromptAdmissionError extends Error {
  constructor() {
    super("Authority prompt capacity is exhausted");
    this.name = "AuthorityPromptAdmissionError";
  }
}

/** One process-local owner-interaction budget shared by every prompt profile. */
export class AuthorityPromptAdmission {
  private active = 0;

  constructor(readonly budget: number) {
    if (!Number.isSafeInteger(budget) || budget <= 0 || budget > 128) {
      throw new AuthorityPromptAdmissionError();
    }
  }

  acquire(): () => void {
    if (this.active >= this.budget) throw new AuthorityPromptAdmissionError();
    this.active += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active -= 1;
    };
  }

  status(): Readonly<{ activePrompts: number; budget: number; saturated: boolean }> {
    return Object.freeze({
      activePrompts: this.active,
      budget: this.budget,
      saturated: this.active >= this.budget,
    });
  }
}
