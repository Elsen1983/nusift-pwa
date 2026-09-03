import { spawn } from "node:child_process";
import { URL } from "node:url";

const requiredUrls = ["DATABASE_URL", "WORKFLOW_POSTGRES_URL"];
for (const name of requiredUrls) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required.`);
  const parsed = new URL(value);
  if (!/^postgres(?:ql)?:$/.test(parsed.protocol) || !parsed.hostname || parsed.pathname === "/") {
    throw new Error(`${name} must be a PostgreSQL database URL.`);
  }
}

const appDatabase = new URL(process.env.DATABASE_URL).pathname;
const workflowDatabase = new URL(process.env.WORKFLOW_POSTGRES_URL).pathname;
if (appDatabase === workflowDatabase) {
  throw new Error("DATABASE_URL and WORKFLOW_POSTGRES_URL must use separate databases.");
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} exited with ${signal ?? code}.`));
    });
  });
}

await run("./node_modules/.bin/prisma", ["migrate", "deploy"]);
await run(process.execPath, ["./node_modules/@workflow/world-postgres/bin/setup.js"]);
