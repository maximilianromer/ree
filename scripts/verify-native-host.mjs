import { spawn } from "node:child_process";
import { resolveNativeHostExecutable } from "../dist/native/setup.js";

const executable = await resolveNativeHostExecutable(false);
const request = Buffer.from(
  JSON.stringify({ id: "native-verification", type: "ping" }),
  "utf8",
);
const header = Buffer.alloc(4);
header.writeUInt32LE(request.length);
const child = spawn(executable, [], {
  stdio: ["pipe", "pipe", "pipe"],
  windowsHide: true,
});
const stdout = [];
let stderr = "";
child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => {
  stderr += chunk;
});
child.stdin.end(Buffer.concat([header, request]));
const timeout = setTimeout(() => child.kill("SIGKILL"), 15_000);
const status = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code, signal) => resolve({ code, signal }));
});
clearTimeout(timeout);
if (status.code !== 0)
  throw new Error(
    `Native host exited with ${status.code ?? status.signal}: ${stderr}`,
  );
const response = Buffer.concat(stdout);
if (response.length < 4)
  throw new Error(`Native host returned no frame: ${stderr}`);
const length = response.readUInt32LE(0);
const body = JSON.parse(response.subarray(4, 4 + length).toString("utf8"));
if (body.id !== "native-verification" || body.type !== "pong")
  throw new Error(`Unexpected native host response: ${JSON.stringify(body)}`);
console.log(`Verified ${executable}: ${JSON.stringify(body)}`);
