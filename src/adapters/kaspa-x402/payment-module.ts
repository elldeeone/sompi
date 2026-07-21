import type {
  KaspaPaymentModule,
  KaspaPreparedExecutionContext,
} from "../../purchase/coordinator.js";

/**
 * The one concrete Kaspa-x402 execution adapter. It routes the two real
 * alpha.9 mechanisms without widening Sompi into a generic payment-rail API.
 */
export class KaspaX402PaymentModule implements KaspaPaymentModule {
  constructor(
    private readonly exact: KaspaPaymentModule,
    private readonly batch: KaspaPaymentModule
  ) {
    if (!exact || !batch) throw new Error("Kaspa-x402 payment modules are incomplete");
  }

  prepare(input: Parameters<KaspaPaymentModule["prepare"]>[0]) {
    return this.forMechanism(
      input.execution.authorizationRequest.executionMechanism
    ).prepare(input);
  }

  submit(input: Parameters<KaspaPaymentModule["submit"]>[0]) {
    return this.forContext(input.context).submit(input);
  }

  observe(input: Parameters<KaspaPaymentModule["observe"]>[0]) {
    return this.forContext(input.context).observe(input);
  }

  recoverFulfilment(
    input: Parameters<NonNullable<KaspaPaymentModule["recoverFulfilment"]>>[0]
  ) {
    const module = this.forContext(input.context);
    if (!module.recoverFulfilment) {
      return Promise.resolve({ status: "pending" } as const);
    }
    return module.recoverFulfilment(input);
  }

  private forContext(context: KaspaPreparedExecutionContext): KaspaPaymentModule {
    if (
      context.preparation.mechanism !==
      context.execution.authorizationRequest.executionMechanism
    ) {
      throw new Error("prepared Kaspa-x402 mechanism changed across the Purchase seam");
    }
    return this.forMechanism(context.preparation.mechanism);
  }

  private forMechanism(
    mechanism: "single-transaction" | "channel-voucher"
  ): KaspaPaymentModule {
    return mechanism === "single-transaction" ? this.exact : this.batch;
  }
}
