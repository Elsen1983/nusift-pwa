import {
  DEFAULT_PAYWALL_REPAIR_LIMIT,
  PAYWALL_REPAIR_CONFIRMATION,
  PAYWALL_REPAIR_PRODUCTION_CONFIRMATION,
  formatPaywallRepairReport,
  runPaywallRepair,
} from "../server/utils/news-pipeline/paywall-repair";

const args = new Set(process.argv.slice(2));
const valueOf = (prefix: string): string | undefined => {
  const value = process.argv.find((arg) => arg.startsWith(`${prefix}=`));
  return value?.slice(prefix.length + 1);
};

const apply = args.has("--apply");
const production = args.has("--production");
const confirmation = valueOf("--confirmation");
const productionConfirmation = valueOf("--production-confirmation");
const limitValue = valueOf("--limit");
const parsedLimit = limitValue === undefined ? DEFAULT_PAYWALL_REPAIR_LIMIT : Number(limitValue);
const sourceId = valueOf("--source-id");

if (!Number.isFinite(parsedLimit)) {
  throw new Error("--limit must be a finite number.");
}

if (production && productionConfirmation !== PAYWALL_REPAIR_PRODUCTION_CONFIRMATION) {
  throw new Error(`Production mode requires --production-confirmation=${PAYWALL_REPAIR_PRODUCTION_CONFIRMATION}.`);
}

if (apply && confirmation !== PAYWALL_REPAIR_CONFIRMATION) {
  throw new Error(`Apply mode requires --confirmation=${PAYWALL_REPAIR_CONFIRMATION}.`);
}

if (apply && !process.env.DATABASE_URL) {
  throw new Error("Apply mode requires DATABASE_URL; no repair was performed.");
}

const report = await runPaywallRepair({
  apply,
  confirmation,
  production,
  productionConfirmation,
  limit: parsedLimit,
  sourceId,
});

console.log(formatPaywallRepairReport(report));
