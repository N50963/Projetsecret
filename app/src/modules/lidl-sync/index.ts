export { LidlSyncError, ReauthRequiredError, type LidlErrorCode } from "./errors";
export { LidlClient, type LidlClientOptions, type TicketDetail, type TicketPage, type TicketSummary } from "./lidlClient";
export { buildReceiptPayload, type BuiltReceipt, type ReceiptPayload } from "./payload";
export { getIngredientPurchases, getPurchasedIngredientLines, type IngredientPurchaseSummary, type PurchasedIngredientLine } from "./purchases";
export { parseQuantity, type PackQuantity, type PackUnit } from "./quantity";
export { parseReceipt, payableCents, PARSER_VERSION, type ReceiptItem } from "./receiptParser";
export { syncNewReceipts, type SyncOptions, type SyncResult, type SyncStatus } from "./sync";
export { createSecureTokenStore, MemoryTokenStore, type SecureStoreLike, type TokenStore } from "./tokenStore";
export {
  base64Url, buildLoginUrl, exchangeCode, extractCode, isLidlCallback, LIDL_REDIRECT_URI, type LidlTokens,
} from "./auth";
