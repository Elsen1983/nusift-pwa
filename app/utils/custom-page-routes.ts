export const CUSTOM_PAGE_ROUTES = [
  {
    name: "verify-email-custom",
    path: "/verify-email",
    file: "app/pages/verifyEmail/verify-email.vue",
  },
  {
    name: "verify-custom",
    path: "/verify",
    file: "app/pages/verifyEmail/verify.vue",
  },
  {
    name: "preloader-custom",
    path: "/preloader-page",
    file: "app/pages/preloader/preloader-first.vue",
  },
  {
    name: "region-calibration-custom",
    path: "/region-calibration",
    file: "app/pages/calibration/region-calibration.vue",
  },
  {
    name: "source-calibration-custom",
    path: "/source-calibration",
    file: "app/pages/calibration/source-calibration.vue",
  },
  {
    name: "interest-calibration-custom",
    path: "/interest-calibration",
    file: "app/pages/calibration/interest-calibration.vue",
  },
  {
    name: "preloader-custom-two",
    path: "/initialization-preloader-page",
    file: "app/pages/preloader/preloader-second.vue",
  },
  {
    name: "dashboard-initiate-custom",
    path: "/dashboard-initiate",
    file: "app/pages/dashboard/initiate-dashboard.vue",
  },
  {
    name: "dashboard-custom",
    path: "/dashboard",
    file: "app/pages/dashboard/dashboard-main.vue",
  },
] as const;

export function inferStaticFilePagePath(file: string): string {
  const pagePath = file
    .replace(/^app\/pages\//, "")
    .replace(/\.vue$/, "")
    .replace(/\/index$/, "");
  return `/${pagePath}`;
}
