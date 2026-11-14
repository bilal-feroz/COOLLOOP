// Starts the COOLLOOP backend (FastAPI) and frontend (Next.js) together.
//   node dev.mjs
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const windows = process.platform === "win32";
const python = path.join(root, "backend", ".venv", windows ? "Scripts/python.exe" : "bin/python");

if (!existsSync(python)) {
  console.error("The backend environment is missing. Run the setup steps in README.md first.");
  process.exit(1);
}
if (!existsSync(path.join(root, "frontend", "node_modules"))) {
  console.error("Frontend packages are missing. Run `npm install` in the frontend folder first.");
  process.exit(1);
}

const children = [];
let stopping = false;

function run(name, command, args, cwd) {
  const child = spawn(command, args, { cwd, shell: windows && command === "npm", stdio: ["ignore", "pipe", "pipe"] });
  const print = (data) => {
    for (const line of String(data).split(/\r?\n/)) if (line.trim()) console.log(`[${name}] ${line}`);
  };
  child.stdout.on("data", print);
  child.stderr.on("data", print);
  child.on("exit", (code) => {
    if (stopping) return;
    console.log(`[${name}] stopped (${code ?? 0})`);
    stop(code ?? 0);
  });
  children.push(child);
}

function stop(code = 0) {
  stopping = true;
  for (const child of children) child.kill();
  process.exit(code);
}

run("api", python, ["-m", "uvicorn", "app.main:app", "--port", "8000"], path.join(root, "backend"));
run("web", "npm", ["run", "dev"], path.join(root, "frontend"));
process.on("SIGINT", () => stop(0));
process.on("SIGTERM", () => stop(0));
console.log("COOLLOOP is starting. Open http://localhost:3000");
