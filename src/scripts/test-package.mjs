import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const TSC_PATH = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc");

const consumerDirectory = mkdtempSync(join(tmpdir(), "openapi-to-zod-schema-package-"));
const outputDirectory = join(consumerDirectory, "output");

try {
  const dependenciesDirectory = join(consumerDirectory, "node_modules");
  mkdirSync(dependenciesDirectory);
  symlinkSync(process.cwd(), join(dependenciesDirectory, "openapi-to-zod-schema"), "junction");
  symlinkSync(join(process.cwd(), "node_modules/zod"), join(dependenciesDirectory, "zod"), "junction");
  symlinkSync(join(process.cwd(), "node_modules/@types"), join(dependenciesDirectory, "@types"), "junction");

  const consumerFiles = ["import.mts", "require.cts"].map((fileName) => {
    const consumerFileName = join(consumerDirectory, fileName);
    copyFileSync(join("tests/package", fileName), consumerFileName);

    return consumerFileName;
  });
  execFileSync(
    process.execPath,
    [
      TSC_PATH,
      "--target",
      "es2020",
      "--module",
      "nodenext",
      "--strict",
      "--types",
      "node",
      "--typeRoots",
      join(dependenciesDirectory, "@types"),
      "--rootDir",
      consumerDirectory,
      "--outDir",
      outputDirectory,
      ...consumerFiles,
    ],
    { cwd: consumerDirectory, stdio: "inherit" }
  );

  execFileSync(process.execPath, [join(outputDirectory, "import.mjs")], { stdio: "inherit" });
  execFileSync(process.execPath, [join(outputDirectory, "require.cjs")], { stdio: "inherit" });
  console.log("ESM and CommonJS package consumers passed.");

  const specFileName = join(consumerDirectory, "spec.json");
  writeFileSync(specFileName, JSON.stringify({ components: { schemas: { Message: { type: "string" } } } }));
  const packageDirectory = join(dependenciesDirectory, "openapi-to-zod-schema");
  const { bin } = JSON.parse(readFileSync(join(packageDirectory, "package.json"), "utf8"));
  const generatedCode = execFileSync(
    process.execPath,
    [join(packageDirectory, bin["openapi-to-zod-schema"]), specFileName],
    { encoding: "utf8" }
  );
  if (!generatedCode.includes("export const MessageSchema = z.string()")) {
    throw new Error(`The packaged command did not print the expected schema:\n${generatedCode}`);
  }

  console.log("Packaged command passed.");
} finally {
  rmSync(consumerDirectory, { recursive: true, force: true });
}
