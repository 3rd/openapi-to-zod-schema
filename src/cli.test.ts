import { spawnSync } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { parseSpecContent } from "./cli.ts";

describe("CLI spec content sniffing", () => {
  it("parses JSON content without an extension hint", () => {
    const parsed = parseSpecContent('{"components": {"schemas": {}}}');
    expect(parsed).toEqual({ components: { schemas: {} } });
  });

  it("parses YAML content without an extension hint", () => {
    const parsed = parseSpecContent("components:\n  schemas: {}\n");
    expect(parsed).toEqual({ components: { schemas: {} } });
  });

  it("rejects content that is neither a JSON nor a YAML object", () => {
    expect(() => parseSpecContent("42")).toThrow("Unsupported file format");
    expect(() => parseSpecContent("{invalid")).toThrow("Unsupported file format");
  });

  it.each([
    ["a components array", '{"components":[]}', "#/components: expected an object, received array"],
    ["a null components value", '{"components":null}', "#/components: expected an object, received null"],
    ["a schemas array", '{"components":{"schemas":[]}}', "#/components/schemas: expected an object, received array"],
    [
      "a scalar schema",
      '{"components":{"schemas":{"Item":42}}}',
      "#/components/schemas/Item: expected a schema object, received number",
    ],
    [
      "an array schema",
      '{"components":{"schemas":{"Item":[]}}}',
      "#/components/schemas/Item: expected a schema object, received array",
    ],
    [
      "a non-string reference",
      '{"components":{"schemas":{"Item":{"$ref":42}}}}',
      "#/components/schemas/Item/$ref: expected a string, received number",
    ],
    [
      "a scalar composition",
      '{"components":{"schemas":{"Item":{"allOf":{}}}}}',
      "#/components/schemas/Item/allOf: expected an array, received object",
    ],
    [
      "a null composition member",
      '{"components":{"schemas":{"Item":{"oneOf":[null]}}}}',
      "#/components/schemas/Item/oneOf/0: expected a schema object, received null",
    ],
    [
      "a scalar composition member",
      '{"components":{"schemas":{"Item":{"anyOf":[42]}}}}',
      "#/components/schemas/Item/anyOf/0: expected a schema object, received number",
    ],
    [
      "a properties array",
      '{"components":{"schemas":{"Item":{"type":"object","properties":[]}}}}',
      "#/components/schemas/Item/properties: expected an object, received array",
    ],
    [
      "a scalar property",
      '{"components":{"schemas":{"Item":{"type":"object","properties":{"first/last~name":42}}}}}',
      "#/components/schemas/Item/properties/first~1last~0name: expected a schema object, received number",
    ],
    [
      "a scalar property of a schema without a type",
      '{"components":{"schemas":{"Item":{"properties":{"name":42}}}}}',
      "#/components/schemas/Item/properties/name: expected a schema object, received number",
    ],
    [
      "a required value that is not a list",
      '{"components":{"schemas":{"Item":{"type":"object","required":true}}}}',
      "#/components/schemas/Item/required: expected an array, received boolean",
    ],
    [
      "a required name that is not a string",
      '{"components":{"schemas":{"Item":{"type":"object","required":[42]}}}}',
      "#/components/schemas/Item/required/0: expected a string, received number",
    ],
    [
      "scalar array items",
      '{"components":{"schemas":{"Item":{"type":"array","items":42}}}}',
      "#/components/schemas/Item/items: expected a schema object, received number",
    ],
    [
      "scalar additional properties",
      '{"components":{"schemas":{"Item":{"type":"object","additionalProperties":42}}}}',
      "#/components/schemas/Item/additionalProperties: expected a schema object or a boolean, received number",
    ],
  ])("rejects documents containing %s", (_description, content, location) => {
    expect(() => parseSpecContent(content)).toThrow(`Invalid OpenAPI document at ${location}.`);
  });

  it("treats empty YAML values for schemas, properties and object keywords as absent", () => {
    const parsed = parseSpecContent(`components:
  schemas:
    Empty:
    Pet:
      type: object
      properties:
        tag:
        names:
          type: array
          items:
      required:
      additionalProperties:
    Bare:
      type: object
      properties:
    Untyped:
      properties:
`);

    expect(parsed.components?.schemas).toEqual({
      Empty: undefined,
      Pet: { type: "object", properties: { tag: undefined, names: { type: "array" } } },
      Bare: { type: "object" },
      Untyped: {},
    });
  });

  it("ignores type, nullable and enum values of the wrong kind with a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    const parsed = parseSpecContent(
      '{"components":{"schemas":{"Item":{"type":["string","null"],"nullable":"yes","enum":"a","description":"kept"},"Link":{"$ref":"#/components/schemas/Item","nullable":"yes"}}}}'
    );
    expect(parsed.components?.schemas).toEqual({
      Item: { description: "kept" },
      Link: { $ref: "#/components/schemas/Item" },
    });
    expect(warnSpy.mock.calls).toEqual([
      ["Warning: Ignoring #/components/schemas/Item/type: expected a string, received array"],
      ["Warning: Ignoring #/components/schemas/Item/nullable: expected a boolean, received string"],
      ["Warning: Ignoring #/components/schemas/Item/enum: expected an array, received string"],
      ["Warning: Ignoring #/components/schemas/Link/nullable: expected a boolean, received string"],
    ]);

    warnSpy.mockRestore();
  });

  it("does not check object and array keywords on schemas of another type", () => {
    const content = '{"components":{"schemas":{"Name":{"type":"string","required":true,"properties":42,"items":42}}}}';

    expect(parseSpecContent(content)).toEqual(JSON.parse(content));
  });

  it("does not check object keywords on a schema with no type and an empty properties value", () => {
    const parsed = parseSpecContent("components:\n  schemas:\n    Item:\n      properties:\n      required: true\n");

    expect(parsed.components?.schemas).toEqual({ Item: { required: true } });
  });

  it("keeps components and properties named __proto__", () => {
    const content =
      '{"components":{"schemas":{"__proto__":{"type":"object","properties":{"__proto__":{"type":"string"}}}}}}';

    expect(parseSpecContent(content)).toEqual(JSON.parse(content));
  });

  it.each(["{}", '{"components":{}}'])("accepts documents without schemas: %s", (content) => {
    expect(parseSpecContent(content)).toEqual(JSON.parse(content));
  });

  it("preserves supported schemas and unknown keywords", () => {
    const content = `components:
  schemas:
    Item:
      type: object
      properties:
        status:
          enum: [active, 2, true, null]
          nullable: true
        entries:
          type: array
          items:
            $ref: '#/components/schemas/Unknown'
        owner:
          $ref: '#/components/schemas/Unknown'
          nullable: true
      required: [status]
      additionalProperties: false
      description: A supported description
    Alternatives:
      allOf:
        - anyOf:
            - oneOf: [{ type: string }, {}]
    Extension:
      type: vendor-specific
      x-vendor: { enabled: true }
`;
    const parsed = parseSpecContent(content);
    expect(parsed.components?.schemas).toEqual({
      Item: {
        type: "object",
        properties: {
          status: { enum: ["active", 2, true, null], nullable: true },
          entries: { type: "array", items: { $ref: "#/components/schemas/Unknown" } },
          owner: { $ref: "#/components/schemas/Unknown", nullable: true },
        },
        required: ["status"],
        additionalProperties: false,
        description: "A supported description",
      },
      Alternatives: { allOf: [{ anyOf: [{ oneOf: [{ type: "string" }, {}] }] }] },
      Extension: { type: "vendor-specific", "x-vendor": { enabled: true } },
    });
  });
});

describe("CLI execution", () => {
  const cliPath = path.join(import.meta.dirname, "bin.ts");
  let fixturesDirectory: string;

  beforeAll(() => {
    fixturesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "openapi-cli-test-"));
  });

  afterAll(() => {
    fs.rmSync(fixturesDirectory, { recursive: true, force: true });
  });

  it("rejects malformed input without replacing an existing output file", () => {
    const directory = fs.mkdtempSync(path.join(fixturesDirectory, "invalid-"));
    const inputPath = path.join(directory, "spec.json");
    const outputPath = path.join(directory, "schemas.ts");
    fs.writeFileSync(inputPath, "[]");
    fs.writeFileSync(outputPath, "existing schemas");

    const result = spawnSync(process.execPath, [cliPath, inputPath, "-o", outputPath], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Unsupported file format");
    expect(fs.readFileSync(outputPath, "utf8")).toBe("existing schemas");
  });

  it.each(["-o", "--prefix"])("rejects a missing %s value before reading input", (option) => {
    const result = spawnSync(process.execPath, [cliPath, "/missing-openapi-document.json", option], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(`Please provide a value for ${option}.`);
  });

  it("rejects an option in place of an output value", () => {
    const result = spawnSync(process.execPath, [cliPath, "/missing-openapi-document.json", "-o", "--prefix", "Api"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Please provide a value for -o.");
  });

  it("rejects an empty output path before reading input", () => {
    const result = spawnSync(process.execPath, [cliPath, "/missing-openapi-document.json", "-o", ""], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Please provide a value for -o.");
  });

  it("generates schemas and warns for a document with unsupported type and enum values", () => {
    const directory = fs.mkdtempSync(path.join(fixturesDirectory, "degraded-"));
    const inputPath = path.join(directory, "spec.yaml");
    fs.writeFileSync(
      inputPath,
      `components:
  schemas:
    Pet:
      type: object
      properties:
        name:
          type: [string, "null"]
        position:
          enum: [[0, 0], [1, 1]]
        owner:
          type: [object, "null"]
          properties:
            id:
              type: string
        vaccine:
          type: object
          oneOf:
            - required: true
      required: [name]
`
    );

    const result = spawnSync(process.execPath, [cliPath, inputPath], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("export const PetSchema = z.object({");
    expect(result.stdout).toContain("position: z.unknown().optional()");
    expect(result.stdout).toContain("owner: z.unknown().optional()");
    expect(result.stdout).toContain("vaccine: z.looseObject({}).optional()");
    expect(result.stderr).toContain(
      "Warning: Ignoring #/components/schemas/Pet/properties/name/type: expected a string, received array"
    );
  });

  it("writes generated schemas with the requested prefix", () => {
    const directory = fs.mkdtempSync(path.join(fixturesDirectory, "valid-"));
    const inputPath = path.join(directory, "spec.yaml");
    const outputPath = path.join(directory, "schemas.ts");
    fs.writeFileSync(inputPath, "components:\n  schemas:\n    Status:\n      type: string\n");

    const result = spawnSync(process.execPath, [cliPath, inputPath, "-o", outputPath, "--prefix", "Api"], {
      encoding: "utf8",
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(`Zod schema generated and saved to ${outputPath}`);
    expect(fs.readFileSync(outputPath, "utf8")).toContain("export const ApiStatusSchema");
  });
});
