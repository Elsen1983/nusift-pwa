import fs from "fs";
import {
  getHttpSourceMergeAuditReportPath,
  type HttpSourceMergeAuditReport,
} from "./http-source-merge-audit";

export function readHttpSourceMergeAuditReport() {
  return JSON.parse(
    fs.readFileSync(getHttpSourceMergeAuditReportPath(), "utf-8"),
  ) as HttpSourceMergeAuditReport;
}
