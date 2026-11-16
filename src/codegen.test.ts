import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { codegen } from "./codegen.ts";
import { convertOpenAPISpecToZodSchemas, type OpenAPISpec } from "./converter.ts";

const TSC_PATH = join(dirname(createRequire(import.meta.url).resolve("typescript/package.json")), "bin/tsc");

let generatedModulesDirectory: string;

beforeAll(() => {
  generatedModulesDirectory = mkdtempSync(join(tmpdir(), "openapi-codegen-test-"));
  symlinkSync(resolve("node_modules"), join(generatedModulesDirectory, "node_modules"), "junction");
});

afterAll(() => {
  rmSync(generatedModulesDirectory, { recursive: true, force: true });
});

const writeGeneratedModule = (code: string) => {
  const modulePath = join(generatedModulesDirectory, `${randomUUID()}.ts`);
  writeFileSync(modulePath, code);

  return modulePath;
};

const evaluateSchema = async (code: string, schemaName: string) => {
  const schemasByName: Record<string, unknown> = await import(pathToFileURL(writeGeneratedModule(code)).href);

  return z.instanceof(z.ZodType).parse(schemasByName[schemaName]);
};

const findTypeErrors = (code: string) => {
  const result = spawnSync(
    process.execPath,
    [
      TSC_PATH,
      "--noEmit",
      "--strict",
      "--skipLibCheck",
      "--target",
      "es2020",
      "--module",
      "nodenext",
      "--pretty",
      "false",
      writeGeneratedModule(code),
    ],
    { cwd: generatedModulesDirectory, encoding: "utf8" }
  );
  if (result.error) throw result.error;

  return `${result.stdout}${result.stderr}`.split("\n").filter((line) => line !== "");
};

describe("codegen", () => {
  it("generates schema with refs", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          User: {
            type: "object",
            properties: {
              id: { type: "integer" },
              name: { type: "string" },
              email: { type: "string" },
              roles: { type: "array", items: { type: "string" } },
            },
            required: ["id", "email"],
          },
          Post: {
            type: "object",
            properties: {
              id: { type: "integer" },
              title: { type: "string" },
              content: { type: "string" },
              author: { $ref: "#/components/schemas/User" },
            },
            required: ["id", "title", "content", "author"],
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toBe(`import { z } from 'zod';

export const UserSchema = z.object({
  id: z.int(),
  name: z.string().optional(),
  email: z.string(),
  roles: z.array(z.string()).optional()
});

export const PostSchema = z.object({
  id: z.int(),
  title: z.string(),
  content: z.string(),
  author: UserSchema
});`);
  });

  it("generates string length and date validation through references and compositions", async () => {
    const code = codegen({
      components: {
        schemas: {
          Entry: {
            type: "object",
            properties: {
              name: { $ref: "#/components/schemas/Name" },
              mark: { type: "string", maxLength: 1 },
              date: { type: "string", format: "date", nullable: true },
              empty: { type: "string", minLength: 0, maxLength: 0 },
            },
            required: ["name", "mark", "date", "empty"],
          },
          Name: { type: "string", minLength: 2, maxLength: 3 },
          Choice: { type: "string", minLength: 2, allOf: [{ enum: ["a", "ok"] }] },
          LongDate: { type: "string", format: "date", minLength: 11 },
          ShortDate: { type: "string", format: "date", maxLength: 9 },
        },
      },
    });
    const entry = await evaluateSchema(code, "EntrySchema");
    const valid = { name: "😀a", mark: "😀", date: "2024-02-29", empty: "" };

    expect(findTypeErrors(code)).toEqual([]);
    expect(entry.parse(valid)).toEqual(valid);
    expect(entry.safeParse({ ...valid, name: "😀" }).success).toBe(false);
    expect(entry.safeParse({ ...valid, name: "abcd" }).success).toBe(false);
    expect(entry.safeParse({ ...valid, mark: "ab" }).success).toBe(false);
    expect(entry.safeParse({ ...valid, date: "2023-02-29" }).success).toBe(false);
    expect(entry.safeParse({ ...valid, date: null }).success).toBe(true);
    expect(entry.safeParse({ ...valid, empty: "a" }).success).toBe(false);

    const choice = await evaluateSchema(code, "ChoiceSchema");
    expect(choice.parse("ok")).toBe("ok");
    expect(choice.safeParse("a").success).toBe(false);
    expect(choice.safeParse("no").success).toBe(false);
    expect((await evaluateSchema(code, "LongDateSchema")).safeParse("2024-02-29").success).toBe(false);
    expect((await evaluateSchema(code, "ShortDateSchema")).safeParse("2024-02-29").success).toBe(false);
  });

  it("generates only enum values satisfying the string constraints", async () => {
    const code = codegen({
      components: {
        schemas: {
          Bounded: { type: "string", enum: ["a", "ok", "oversized", "😀😀"], minLength: 2, maxLength: 3 },
          Date: { type: "string", enum: ["2024-02-29", "2023-02-29", "bad"], format: "date" },
          Impossible: { type: "string", enum: ["a"], minLength: 2 },
          Nullable: { type: "string", enum: ["bad"], format: "date", nullable: true },
        },
      },
    });
    const bounded = await evaluateSchema(code, "BoundedSchema");
    expect(bounded.parse("ok")).toBe("ok");
    expect(bounded.parse("😀😀")).toBe("😀😀");
    expect(bounded.safeParse("a").success).toBe(false);
    expect(bounded.safeParse("oversized").success).toBe(false);
    expect(bounded.safeParse("new").success).toBe(false);

    const date = await evaluateSchema(code, "DateSchema");
    expect(date.parse("2024-02-29")).toBe("2024-02-29");
    expect(date.safeParse("2023-02-29").success).toBe(false);
    expect(date.safeParse("bad").success).toBe(false);
    expect(date.safeParse("2024-03-01").success).toBe(false);

    const impossible = await evaluateSchema(code, "ImpossibleSchema");
    expect(impossible.safeParse("a").success).toBe(false);
    expect(impossible.safeParse("ok").success).toBe(false);

    const nullable = await evaluateSchema(code, "NullableSchema");
    expect(nullable.parse(null)).toBe(null);
    expect(nullable.safeParse("bad").success).toBe(false);
  });

  it("generates schema with refs in a sequence which prevents lazy usage", () => {
    const spec = {
      components: {
        schemas: {
          Post: {
            type: "object",
            properties: {
              id: { type: "integer" },
              title: { type: "string" },
              content: { type: "string" },
              author: { $ref: "#/components/schemas/User" },
            },
            required: ["id", "title", "content", "author"],
          },
          User: {
            type: "object",
            properties: {
              id: { type: "integer" },
              name: { type: "string" },
              email: { type: "string" },
              roles: { type: "array", items: { type: "string" } },
            },
            required: ["id", "email"],
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toMatchInlineSnapshot(`
      "import { z } from 'zod';

      export const UserSchema = z.object({
        id: z.int(),
        name: z.string().optional(),
        email: z.string(),
        roles: z.array(z.string()).optional()
      });

      export const PostSchema = z.object({
        id: z.int(),
        title: z.string(),
        content: z.string(),
        author: UserSchema
      });"
    `);
  });

  it("generates schema with nested objects and nullable properties", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Sample: {
            type: "object",
            properties: {
              nested: {
                type: "object",
                nullable: true,
                properties: {
                  "deep-Prop": { type: "string" },
                },
              },
            },
            required: ["nested"],
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toBe(`import { z } from 'zod';

export const SampleSchema = z.object({
  nested: z.object({
    "deep-Prop": z.string().optional()
  }).nullable()
});`);
  });

  it("applies the name prefix to declarations and references", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          User: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          Post: {
            type: "object",
            properties: { author: { $ref: "#/components/schemas/User" } },
            required: ["author"],
          },
          "123name": { $ref: "#/components/schemas/User" },
        },
      },
    };
    const code = codegen(spec, "Api");
    expect(code).toContain("export const ApiUserSchema = ");
    expect(code).toContain("export const ApiPostSchema = ");
    expect(code).toContain("export const Api123nameSchema = ApiUserSchema;");
    expect(code).toContain("author: ApiUserSchema\n");
  });

  it("emits string enums and single-value literals", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Color: { type: "string", enum: ["red", "green"] },
          Only: { type: "string", enum: ["only"] },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toContain('export const ColorSchema = z.enum(["red", "green"]);');
    expect(code).toContain('export const OnlySchema = z.literal("only");');
  });

  it("emits numeric enums as literal unions", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Status: { type: "integer", enum: [1, 2] },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toContain("export const StatusSchema = z.union([z.literal(1), z.literal(2)]);");
  });

  it("preserves escaped string values and object keys", async () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Tricky: {
            type: "object",
            properties: {
              'quo"te': { type: "string", enum: ['say "hi"', "line\nbreak", "export const back\\slash"] },
            },
          },
        },
      },
    };
    const code = codegen(spec);
    const schema = await evaluateSchema(code, "TrickySchema");

    expect(schema.parse({ 'quo"te': 'say "hi"' })).toEqual({ 'quo"te': 'say "hi"' });
    expect(schema.parse({ 'quo"te': "line\nbreak" })).toEqual({ 'quo"te': "line\nbreak" });
    expect(schema.parse({ 'quo"te': "export const back\\slash" })).toEqual({ 'quo"te': "export const back\\slash" });
  });

  it("generates strictly compilable schemas for self and mutual recursion", async () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Post: {
            type: "object",
            properties: { author: { $ref: "#/components/schemas/User" } },
            required: ["author"],
          },
          User: {
            type: "object",
            properties: {
              id: { type: "string" },
              manager: {
                anyOf: [
                  { enum: [null] },
                  {
                    allOf: [
                      { $ref: "#/components/schemas/User" },
                      {
                        type: "object",
                        properties: { role: { enum: ["manager"] } },
                        required: ["role"],
                      },
                    ],
                  },
                ],
              },
              posts: { type: "array", items: { $ref: "#/components/schemas/Post" } },
            },
            required: ["id", "manager"],
          },
        },
      },
    };
    const code = codegen(spec);
    const schema = await evaluateSchema(code, "UserSchema");

    expect(findTypeErrors(code)).toEqual([]);
    expect(
      schema.parse({
        id: "one",
        manager: { id: "boss", manager: null, role: "manager" },
        posts: [{ author: { id: "two", manager: null } }],
      })
    ).toEqual({
      id: "one",
      manager: { id: "boss", manager: null, role: "manager" },
      posts: [{ author: { id: "two", manager: null } }],
    });
    expect(schema.safeParse({ id: "one", manager: null, posts: [{ author: { id: 2, manager: null } }] }).success).toBe(
      false
    );
    expect(schema.safeParse({ id: "one", manager: { id: "boss", manager: null } }).success).toBe(false);
  });

  it("sanitizes schema names that are not valid identifiers", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          "user-profile": {
            type: "object",
            properties: { id: { type: "string" } },
          },
          "123name": {
            type: "object",
            properties: { ref: { $ref: "#/components/schemas/user-profile" } },
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toContain("export const user_profileSchema = ");
    expect(code).toContain("export const _123nameSchema = ");
    expect(code).toContain("ref: user_profileSchema");
  });

  it("keeps colliding names distinct with an arbitrary prefix", async () => {
    const code = codegen(
      {
        components: {
          schemas: {
            "item-detail": { type: "string" },
            item_detail: { type: "number" },
            Holder: {
              type: "object",
              properties: {
                text: { $ref: "#/components/schemas/item-detail" },
                count: { $ref: "#/components/schemas/item_detail" },
              },
              required: ["text", "count"],
            },
          },
        },
      },
      "1-"
    );
    const schema = await evaluateSchema(code, "_1_HolderSchema");

    expect(schema.parse({ text: "item", count: 1 })).toEqual({ text: "item", count: 1 });
    expect(schema.safeParse({ text: 1, count: "item" }).success).toBe(false);
  });

  it("preserves valid names before assigning sanitized names", async () => {
    const code = codegen({
      components: {
        schemas: {
          "item-detail": { type: "string" },
          item_detail: { type: "number" },
          item_detail2: { type: "boolean" },
          用户: { type: "string" },
          Größe: { type: "number" },
        },
      },
    });

    expect((await evaluateSchema(code, "item_detailSchema")).parse(1)).toBe(1);
    expect((await evaluateSchema(code, "item_detail2Schema")).parse(true)).toBe(true);
    expect((await evaluateSchema(code, "item_detail3Schema")).parse("item")).toBe("item");
    expect((await evaluateSchema(code, "用户Schema")).parse("name")).toBe("name");
    expect((await evaluateSchema(code, "GrößeSchema")).parse(2)).toBe(2);
    expect(findTypeErrors(code)).toEqual([]);
  });

  it("generates working schemas for components and properties named __proto__", async () => {
    const code = codegen({
      components: {
        schemas: {
          ["__proto__"]: {
            type: "object",
            properties: { ["__proto__"]: { type: "string" }, id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          Holder: {
            type: "object",
            properties: { value: { $ref: "#/components/schemas/__proto__" } },
            required: ["value"],
          },
        },
      },
    });
    const schema = await evaluateSchema(code, "HolderSchema");

    expect(schema.safeParse({ value: JSON.parse('{"__proto__":"x","id":"a"}') }).success).toBe(true);
    expect(schema.safeParse({ value: JSON.parse('{"__proto__":"x","id":1}') }).success).toBe(false);
  });

  it("uses sanitized names and prefixes in circular references", async () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          "unit-node": {
            type: "object",
            properties: {
              uid: { type: "string" },
              parentUnit: { $ref: "#/components/schemas/unit-node" },
            },
            required: ["uid"],
          },
        },
      },
    };
    const code = codegen(spec, "Api");
    const schema = await evaluateSchema(code, "Apiunit_nodeSchema");

    expect(schema.parse({ uid: "one", parentUnit: { uid: "two" } })).toEqual({
      uid: "one",
      parentUnit: { uid: "two" },
    });
    expect(schema.safeParse({ uid: "one", parentUnit: { uid: 2 } }).success).toBe(false);
  });

  it("emits records and catchalls for additionalProperties", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Dict: { type: "object", additionalProperties: { type: "string" } },
          Mixed: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: { type: "number" },
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toContain("export const DictSchema = z.record(z.string(), z.string());");
    expect(code).toContain(".catchall(z.number());");
  });

  it("keeps undeclared properties only for objects that allow additional properties", async () => {
    const code = codegen({
      components: {
        schemas: {
          Open: { type: "object", properties: { id: { type: "string" } }, additionalProperties: true },
          Plain: { type: "object", properties: { id: { type: "string" } } },
        },
      },
    });

    expect((await evaluateSchema(code, "OpenSchema")).parse({ id: "x", extra: 1 })).toEqual({ id: "x", extra: 1 });
    expect((await evaluateSchema(code, "PlainSchema")).parse({ id: "x", extra: 1 })).toEqual({ id: "x" });
  });

  it.each([
    { kind: "record", properties: undefined },
    { kind: "catchall", properties: { id: { type: "string" } } },
  ])("evaluates referenced discriminated unions in $kind additionalProperties", async ({ properties }) => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Container: {
            type: "object",
            properties,
            additionalProperties: {
              oneOf: [{ $ref: "#/components/schemas/First" }, { $ref: "#/components/schemas/Second" }],
            },
          },
          First: {
            type: "object",
            properties: { kind: { type: "string", enum: ["first"] } },
            required: ["kind"],
          },
          Second: {
            type: "object",
            properties: { kind: { type: "string", enum: ["second"] } },
            required: ["kind"],
          },
        },
      },
    };
    const code = codegen(spec);
    const schema = await evaluateSchema(code, "ContainerSchema");

    expect(schema.parse({ a: { kind: "first" }, b: { kind: "second" } })).toEqual({
      a: { kind: "first" },
      b: { kind: "second" },
    });
    expect(schema.safeParse({ a: { kind: "invalid" } }).success).toBe(false);
  });

  it("keeps overlapping discriminator values as a plain union", async () => {
    const code = codegen({
      components: {
        schemas: {
          User: {
            oneOf: [
              {
                type: "object",
                properties: { kind: { enum: ["user"] }, name: { type: "string" } },
                required: ["kind", "name"],
              },
              {
                type: "object",
                properties: { kind: { enum: ["user"] }, system: { type: "boolean" } },
                required: ["kind", "system"],
              },
            ],
          },
        },
      },
    });
    const schema = await evaluateSchema(code, "UserSchema");

    expect(schema.safeParse({ kind: "user", name: "Ada" }).success).toBe(true);
    expect(schema.safeParse({ kind: "user", system: true }).success).toBe(true);
    expect(schema.safeParse({ kind: "user" }).success).toBe(false);
  });

  it("accepts the same input as the runtime union when the alternatives differ only in __proto__", async () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Choice: {
            oneOf: [
              { type: "object", properties: { ["__proto__"]: { enum: ["a"] } }, required: ["__proto__"] },
              { type: "object", properties: { ["__proto__"]: { enum: ["b"] } }, required: ["__proto__"] },
            ],
          },
        },
      },
    };
    const generated = await evaluateSchema(codegen(spec), "ChoiceSchema");
    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(generated.safeParse({}).success).toBe(map.Choice.safeParse({}).success);
  });

  it("escapes discriminator property names", async () => {
    const code = codegen({
      components: {
        schemas: {
          Choice: {
            oneOf: [
              { type: "object", properties: { 'kind"': { enum: ["first"] } }, required: ['kind"'] },
              { type: "object", properties: { 'kind"': { enum: ["second"] } }, required: ['kind"'] },
            ],
          },
        },
      },
    });
    const schema = await evaluateSchema(code, "ChoiceSchema");

    expect(schema.parse({ 'kind"': "first" })).toEqual({ 'kind"': "first" });
    expect(schema.safeParse({ 'kind"': "invalid" }).success).toBe(false);
  });

  it("preserves every allOf constraint through referenced properties", async () => {
    const code = codegen({
      components: {
        schemas: {
          Derived: {
            allOf: [
              { $ref: "#/components/schemas/Base" },
              {
                type: "object",
                properties: { state: { enum: ["active", "closed"] }, count: { type: "integer" } },
                required: ["count"],
              },
            ],
          },
          Base: {
            type: "object",
            properties: {
              id: { type: "string" },
              state: { enum: ["active", "pending"] },
              owner: { $ref: "#/components/schemas/Owner" },
            },
            required: ["id", "state", "payload"],
          },
          Owner: { type: "string" },
        },
      },
    });
    const schema = await evaluateSchema(code, "DerivedSchema");

    expect(code).toContain("owner: OwnerSchema.optional()");
    expect(code).toContain("export const DerivedSchema = z.intersection(BaseSchema, ");
    expect(schema.parse({ id: "one", state: "active", count: 1, payload: null })).toEqual({
      id: "one",
      state: "active",
      count: 1,
      payload: null,
    });
    expect(schema.safeParse({ id: "one", state: "pending", count: 1, payload: null }).success).toBe(false);
    expect(schema.safeParse({ id: "one", state: "closed", count: 1, payload: null }).success).toBe(false);
    expect(schema.safeParse({ state: "active", count: 1, payload: null }).success).toBe(false);
    expect(schema.safeParse({ id: "one", state: "active", count: 1.5, payload: null }).success).toBe(false);
    expect(schema.safeParse({ id: "one", state: "active", count: 1 }).success).toBe(false);
  });

  it("resolves cyclic allOf inheritance through reference aliases", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const code = codegen({
      components: {
        schemas: {
          First: { allOf: [{ $ref: "#/components/schemas/Alias" }] },
          Alias: { $ref: "#/components/schemas/Second" },
          Second: {
            allOf: [
              { $ref: "#/components/schemas/First" },
              { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
            ],
          },
        },
      },
    });
    const schema = await evaluateSchema(code, "FirstSchema");

    expect(schema.parse({ id: "one" })).toEqual({ id: "one" });
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ id: 1 }).success).toBe(false);

    warnSpy.mockRestore();
  });

  it("preserves nullable enums and closed object validation", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const code = codegen({
      components: {
        schemas: {
          Settings: {
            type: "object",
            properties: { mode: { type: "string", enum: ["on", null], nullable: true } },
            required: ["mode"],
            additionalProperties: false,
          },
          Impossible: { type: "string", enum: [null] },
        },
      },
    });
    const schema = await evaluateSchema(code, "SettingsSchema");
    const impossibleSchema = await evaluateSchema(code, "ImpossibleSchema");

    expect(schema.parse({ mode: null })).toEqual({ mode: null });
    expect(schema.safeParse({ mode: "off" }).success).toBe(false);
    expect(schema.safeParse({ mode: "on", extra: true }).success).toBe(false);
    expect(impossibleSchema.safeParse(null).success).toBe(false);
    expect(impossibleSchema.safeParse("on").success).toBe(false);

    warnSpy.mockRestore();
  });

  it("preserves the unknown branch when a union contains a non-descending reference cycle", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const code = codegen({
      components: {
        schemas: {
          Choice: { anyOf: [{ $ref: "#/components/schemas/Choice" }, { type: "string" }] },
        },
      },
    });

    expect((await evaluateSchema(code, "ChoiceSchema")).parse(null)).toBe(null);

    warnSpy.mockRestore();
  });

  it("preserves referenced additional-property constraints in intersections", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Impossible: { type: "string", enum: [1] },
          Settings: {
            type: "object",
            properties: { id: { type: "string" } },
            additionalProperties: { $ref: "#/components/schemas/Impossible" },
          },
          ExtendedSettings: {
            allOf: [
              { $ref: "#/components/schemas/Settings" },
              { type: "object", properties: { extra: { type: "string" } } },
            ],
          },
        },
      },
    };
    const code = codegen(spec);
    const schema = await evaluateSchema(code, "SettingsSchema");

    expect(schema.parse({ id: "one" })).toEqual({ id: "one" });
    expect(schema.safeParse({ id: "one", extra: "two" }).success).toBe(false);

    const { map } = convertOpenAPISpecToZodSchemas(spec);
    const extendedSchema = await evaluateSchema(code, "ExtendedSettingsSchema");
    expect(map.ExtendedSettings.safeParse({ extra: "two" }).success).toBe(false);
    expect(extendedSchema.safeParse({ extra: "two" }).success).toBe(false);

    warnSpy.mockRestore();
  });

  it("emits only the import header for an empty spec", () => {
    const code = codegen({ components: { schemas: {} } });
    expect(code).toBe("import { z } from 'zod';\n\n");
  });
  it("generates union schema with discriminator", () => {
    const spec = {
      components: {
        schemas: {
          User: {
            oneOf: [
              {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  kind: { type: "string", enum: ["user"] },
                  name: { type: "string" },
                },
                required: ["id", "kind"],
              },
              {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  kind: { type: "string", enum: ["systemuser"] },
                  system: { type: "string" },
                },
                required: ["id", "kind"],
              },
            ],
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toMatchInlineSnapshot(`
      "import { z } from 'zod';

      export const UserSchema = z.discriminatedUnion("kind", [z.object({
        id: z.int(),
        kind: z.literal("user"),
        name: z.string().optional()
      }), z.object({
        id: z.int(),
        kind: z.literal("systemuser"),
        system: z.string().optional()
      })]);"
    `);
  });
  it("generates union schema with discriminator for referenced schemas", () => {
    const spec = {
      components: {
        schemas: {
          SystemUser: {
            type: "object",
            properties: {
              id: { type: "integer" },
              kind: { type: "string", enum: ["systemuser"] },
              system: { type: "string" },
            },
            required: ["id", "kind"],
          },
          User: {
            oneOf: [
              {
                type: "object",
                properties: {
                  id: { type: "integer" },
                  kind: { type: "string", enum: ["user"] },
                  name: { type: "string" },
                },
                required: ["id", "kind"],
              },
              {
                $ref: "#/components/schemas/SystemUser",
              },
            ],
          },
        },
      },
    };
    const code = codegen(spec);
    expect(code).toMatchInlineSnapshot(`
      "import { z } from 'zod';

      export const SystemUserSchema = z.object({
        id: z.int(),
        kind: z.literal("systemuser"),
        system: z.string().optional()
      });

      export const UserSchema = z.discriminatedUnion("kind", [z.object({
        id: z.int(),
        kind: z.literal("user"),
        name: z.string().optional()
      }), SystemUserSchema]);"
    `);
  });
});
