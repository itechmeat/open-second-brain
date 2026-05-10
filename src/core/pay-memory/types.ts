/**
 * Shared types for the Pay Memory layer.
 *
 * Inputs and outputs of the four core helpers (`writeReceipt`, `writeAsset`,
 * `aggregateReceipts`, `writeReport`). Intentionally separate from the CLI/MCP
 * surfaces — both layers translate user/agent inputs into these shapes and
 * delegate, so the helpers stay pure and easy to test.
 */

export interface ReceiptInput {
  readonly agent: string;
  readonly service: string;
  readonly status: string;
  readonly reason: string;
  readonly category?: string | null;
  readonly endpoint?: string | null;
  readonly expectedCost?: string | null;
  readonly actualAmount?: string | null;
  readonly currency?: string | null;
  readonly paymentProof?: string | null;
  readonly resultRef?: string | null;
  readonly resultNote?: string | null;
  readonly rawOutput?: string | null;
  readonly slug?: string | null;
  readonly date?: string | null;
  readonly time?: string | null;
  readonly overwrite?: boolean;
  readonly tz?: string | null;
}

export interface ReceiptOutput {
  readonly path: string;
  readonly relativePath: string;
  readonly slug: string;
  readonly date: string;
  readonly created: string;
}

export interface AssetInput {
  readonly title: string;
  readonly service: string;
  readonly resultUrl: string;
  readonly sourceReceipt?: string | null;
  readonly prompt?: string | null;
  readonly usedIn?: string | null;
  readonly slug?: string | null;
  readonly overwrite?: boolean;
}

export interface AssetOutput {
  readonly path: string;
  readonly relativePath: string;
  readonly slug: string;
  readonly created: string;
}

export interface ReportInput {
  readonly date: string;
  readonly title?: string | null;
  readonly task?: string | null;
  readonly slug?: string | null;
  readonly overwrite?: boolean;
}

export interface ReportOutput {
  readonly path: string;
  readonly relativePath: string;
  readonly slug: string;
  readonly receiptsUsed: number;
}

export interface PaymentReceiptSummary {
  readonly path: string;
  readonly service: string;
  readonly status: string;
  readonly category: string | null;
  readonly actualAmount: string | null;
  readonly currency: string | null;
  readonly resultRef: string | null;
  readonly resultNote: string | null;
  readonly reason: string | null;
}
