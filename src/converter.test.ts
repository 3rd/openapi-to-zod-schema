import { describe, expect, it, vi } from "vitest";
import {
  convertOpenAPISpecToZodSchemas,
  type OpenAPISchemaObject,
  type OpenAPISchemaString,
  type OpenAPISpec,
} from "./converter.ts";

describe("OpenAPI to Zod Converter", () => {
  it("converts basic types correctly", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          BasicTypes: {
            type: "object",
            properties: {
              stringProp: { type: "string" },
              numberProp: { type: "number" },
              integerProp: { type: "integer" },
              booleanProp: { type: "boolean" },
              arrayProp: { type: "array", items: { type: "string" } },
            },
            required: ["stringProp", "numberProp", "booleanProp", "arrayProp", "integerProp"],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    const valid = map.BasicTypes.safeParse({
      stringProp: "test",
      numberProp: 123,
      integerProp: 456,
      booleanProp: true,
      arrayProp: ["a", "b", "c"],
    });
    expect(valid.success).toBe(true);

    const wrongType = map.BasicTypes.safeParse({
      stringProp: 42,
      numberProp: 123,
      integerProp: 456,
      booleanProp: true,
      arrayProp: [],
    });
    expect(wrongType.success).toBe(false);

    const missingRequired = map.BasicTypes.safeParse({
      stringProp: "test",
    });
    expect(missingRequired.success).toBe(false);
  });

  it.each([
    {
      name: "minimum length",
      schema: { type: "string", minLength: 2 },
      accepted: ["ab", "😀a", "abcd"],
      rejected: ["", "a", "😀"],
    },
    {
      name: "maximum length",
      schema: { type: "string", maxLength: 1 },
      accepted: ["", "a", "😀"],
      rejected: ["ab", "😀a", "e\u0301"],
    },
    {
      name: "combined length bounds",
      schema: { type: "string", minLength: 2, maxLength: 3 },
      accepted: ["ab", "abc"],
      rejected: ["a", "abcd"],
    },
    {
      name: "zero length bounds",
      schema: { type: "string", minLength: 0, maxLength: 0 },
      accepted: [""],
      rejected: ["a"],
    },
  ] satisfies { name: string; schema: OpenAPISchemaString; accepted: string[]; rejected: string[] }[])(
    "enforces $name in Unicode code points",
    ({ schema, accepted, rejected }) => {
      const { map } = convertOpenAPISpecToZodSchemas({ components: { schemas: { Value: schema } } });

      for (const value of accepted) {
        expect(map.Value.parse(value)).toBe(value);
      }

      for (const value of rejected) {
        expect(map.Value.safeParse(value).success).toBe(false);
      }
    }
  );

  it("validates date strings without coercing them", () => {
    const { map } = convertOpenAPISpecToZodSchemas({
      components: {
        schemas: {
          Date: { type: "string", format: "date", nullable: true },
          LongDate: { type: "string", format: "date", minLength: 11 },
          ShortDate: { type: "string", format: "date", maxLength: 9 },
          Custom: { type: "string", format: "vendor-specific", minLength: 1 },
        },
      },
    });

    expect(map.Date.parse("2024-02-29")).toBe("2024-02-29");
    expect(map.Date.parse(null)).toBe(null);
    expect(map.Date.safeParse("2023-02-29").success).toBe(false);
    expect(map.Date.safeParse("2024-02-29T00:00:00Z").success).toBe(false);
    expect(map.Date.safeParse(new Date("2024-02-29")).success).toBe(false);
    expect(map.LongDate.safeParse("2024-02-29").success).toBe(false);
    expect(map.ShortDate.safeParse("2024-02-29").success).toBe(false);
    expect(map.Custom.parse("text")).toBe("text");
    expect(map.Custom.safeParse("").success).toBe(false);
  });

  it.each([
    {
      name: "length bounds on multiple enum values",
      schema: { type: "string", enum: ["a", "ok", "oversized", "😀😀"], minLength: 2, maxLength: 3 },
      accepted: ["ok", "😀😀"],
      rejected: ["a", "oversized", "new"],
    },
    {
      name: "a singleton enum excluded by its constraints",
      schema: { type: "string", enum: ["a"], minLength: 2 },
      accepted: [],
      rejected: ["a", "ok"],
    },
    {
      name: "date validation on enum values",
      schema: { type: "string", enum: ["2024-02-29", "2023-02-29", "bad"], format: "date" },
      accepted: ["2024-02-29"],
      rejected: ["2023-02-29", "bad", "2024-03-01"],
    },
    {
      name: "nullability when every string enum value is excluded",
      schema: { type: "string", enum: ["bad"], format: "date", nullable: true },
      accepted: [null],
      rejected: ["bad", "2024-02-29"],
    },
    {
      name: "an explicit null alongside constrained enum values",
      schema: { type: "string", enum: [null, "bad", "2024-02-29"], format: "date", nullable: true },
      accepted: [null, "2024-02-29"],
      rejected: ["bad"],
    },
  ] satisfies {
    name: string;
    schema: OpenAPISchemaString;
    accepted: unknown[];
    rejected: unknown[];
  }[])("preserves $name", ({ schema, accepted, rejected }) => {
    const { map } = convertOpenAPISpecToZodSchemas({ components: { schemas: { Value: schema } } });

    for (const value of accepted) {
      expect(map.Value.parse(value)).toBe(value);
    }

    for (const value of rejected) {
      expect(map.Value.safeParse(value).success).toBe(false);
    }
  });

  it("validates required references without duplicate missing-field errors", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          ReferencedType: {
            type: "object",
            properties: {
              prop: { type: "string" },
            },
            required: ["prop"],
          },
          MainType: {
            type: "object",
            properties: {
              refProp: { $ref: "#/components/schemas/ReferencedType" },
            },
            required: ["refProp"],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.MainType.safeParse({ refProp: { prop: "test" } }).success).toBe(true);
    expect(map.MainType.safeParse({ refProp: { prop: 42 } }).success).toBe(false);
    expect(map.MainType.safeParse({})).toMatchObject({
      success: false,
      error: { issues: [{ code: "invalid_type", path: ["refProp"] }] },
    });
  });

  it("handles allOf correctly", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          AllOfType: {
            allOf: [
              { type: "object", properties: { prop1: { type: "string" } }, required: ["prop1"] },
              { type: "object", properties: { prop2: { type: "number" } }, required: ["prop2"] },
            ],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.AllOfType.safeParse({ prop1: "test", prop2: 123 }).success).toBe(true);
    expect(map.AllOfType.safeParse({ prop2: 123 }).success).toBe(false);
  });

  it("requires inherited fields alongside allOf extension fields", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Base: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          Extended: {
            allOf: [
              { $ref: "#/components/schemas/Base" },
              { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
            ],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Extended.parse({ id: "abc", name: "test" })).toEqual({ id: "abc", name: "test" });
    expect(map.Extended.safeParse({ name: "test" }).success).toBe(false);
    expect(map.Extended.safeParse({ id: "abc" }).success).toBe(false);
  });

  it("validates additional properties inside allOf members", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          AllOfDict: {
            allOf: [
              {
                type: "object",
                properties: { id: { type: "string" } },
                required: ["id"],
                additionalProperties: { type: "number" },
              },
            ],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.AllOfDict.safeParse({ id: "x", extra: 5 }).success).toBe(true);
    expect(map.AllOfDict.safeParse({ id: "x", extra: "not a number" }).success).toBe(false);
  });

  it("requires primitive allOf values to satisfy every member", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          MixedAllOf: {
            allOf: [
              { type: "string", enum: ["a", "b"] },
              { type: "string", enum: ["b", "c"] },
            ],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.MixedAllOf.parse("b")).toBe("b");
    expect(map.MixedAllOf.safeParse("a").success).toBe(false);
    expect(map.MixedAllOf.safeParse("c").success).toBe(false);
  });

  it("enforces overlapping allOf property constraints independently", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          State: {
            allOf: [
              { type: "object", properties: { status: { type: "string", enum: ["draft", "active"] } } },
              { type: "object", properties: { status: { type: "string", enum: ["active", "closed"] } } },
            ],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.State.parse({ status: "active" })).toEqual({ status: "active" });
    expect(map.State.safeParse({ status: "draft" }).success).toBe(false);
    expect(map.State.safeParse({ status: "closed" }).success).toBe(false);
  });

  it("enforces the additional property schema of every allOf member", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Labels: {
            allOf: [
              { type: "object", additionalProperties: { type: "string", enum: ["red", "green"] } },
              { type: "object", additionalProperties: { type: "string", enum: ["green", "blue"] } },
            ],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Labels.parse({ color: "green" })).toEqual({ color: "green" });
    expect(map.Labels.safeParse({ color: "red" }).success).toBe(false);
    expect(map.Labels.safeParse({ color: "blue" }).success).toBe(false);
  });

  it("rejects a property that no closed allOf member declares", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Closed: {
            allOf: [
              { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
              { type: "object", properties: { count: { type: "integer" } }, additionalProperties: false },
            ],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Closed.parse({ id: "x", count: 1 })).toEqual({ id: "x", count: 1 });
    expect(map.Closed.safeParse({ id: "x", other: 1 }).success).toBe(false);
  });

  it("keeps a closed object closed next to constraints that declare no properties", () => {
    const closedId: OpenAPISchemaObject = {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    };
    const { map } = convertOpenAPISpecToZodSchemas({
      components: {
        schemas: {
          Auto: {
            type: "object",
            properties: { type: { enum: ["auto"] } },
            required: ["type"],
            additionalProperties: false,
          },
          Manual: {
            type: "object",
            properties: { type: { enum: ["manual"] }, size: { type: "integer" } },
            required: ["type", "size"],
            additionalProperties: false,
          },
          Strategy: {
            type: "object",
            oneOf: [{ $ref: "#/components/schemas/Auto" }, { $ref: "#/components/schemas/Manual" }],
          },
          Identified: { ...closedId, anyOf: [{}, {}] },
          Inherited: { allOf: [closedId, { type: "object" }, {}] },
          Annotated: { allOf: [closedId, { nullable: true }] },
          Wrapped: { type: "object", allOf: [closedId, { required: ["id"] }] },
        },
      },
    });

    expect(map.Strategy.parse({ type: "manual", size: 1 })).toEqual({ type: "manual", size: 1 });
    expect(map.Strategy.safeParse({ type: "auto", extra: 1 }).success).toBe(false);
    expect(map.Identified.parse({ id: "x" })).toEqual({ id: "x" });
    expect(map.Identified.safeParse({ id: "x", extra: 1 }).success).toBe(false);
    expect(map.Inherited.parse({ id: "x" })).toEqual({ id: "x" });
    expect(map.Inherited.safeParse({ id: "x", extra: 1 }).success).toBe(false);
    expect(map.Annotated.safeParse({ id: "x", extra: 1 }).success).toBe(false);
    expect(map.Wrapped.safeParse({ id: "x", extra: 1 }).success).toBe(false);
  });

  it("applies a referenced allOf member that also carries a type", () => {
    const typedReference = { $ref: "#/components/schemas/Identified", type: "object" };
    const { map } = convertOpenAPISpecToZodSchemas({
      components: {
        schemas: {
          Identified: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
          Labeled: {
            allOf: [typedReference, { type: "object", properties: { label: { type: "string" } } }],
          },
        },
      },
    });

    expect(map.Labeled.safeParse({ id: "x", label: "y" }).success).toBe(true);
    expect(map.Labeled.safeParse({ label: "y" }).success).toBe(false);
  });

  it("still requires an object when the composed schemas do not guarantee one", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { map } = convertOpenAPISpecToZodSchemas({
      components: {
        schemas: {
          Mixed: {
            type: "object",
            oneOf: [{ type: "string" }, { type: "object", properties: { id: { type: "string" } } }],
          },
          Nullable: { type: "object", anyOf: [{ type: "object", nullable: true }] },
          Loop: { type: "object", allOf: [{ allOf: [{ $ref: "#/components/schemas/Loop" }, { type: "string" }] }] },
          Open: { allOf: [{ type: "object" }, { type: "object" }] },
          Target: { type: "object", properties: { id: { type: "string" } } },
          NullableReference: { type: "object", allOf: [{ $ref: "#/components/schemas/Target", nullable: true }] },
        },
      },
    });

    expect(map.Mixed.safeParse("text").success).toBe(false);
    expect(map.Mixed.safeParse({ id: "x" }).success).toBe(true);
    expect(map.Nullable.safeParse(null).success).toBe(false);
    expect(map.NullableReference.safeParse(null).success).toBe(false);
    expect(map.Loop.safeParse("text").success).toBe(false);
    expect(map.Open.safeParse("text").success).toBe(false);
    expect(map.Open.parse({ any: 1 })).toEqual({ any: 1 });

    warnSpy.mockRestore();
  });

  it("combines allOf with sibling constraints without broadening nullability", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Mode: {
            type: "string",
            nullable: true,
            allOf: [{ type: "string", enum: ["auto", "manual"] }],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Mode.safeParse("auto").success).toBe(true);
    expect(map.Mode.safeParse(null).success).toBe(false);
  });

  it("resolves cyclic allOf inheritance without losing required fields", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spec: OpenAPISpec = {
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
          Recursive: { allOf: [{ $ref: "#/components/schemas/Recursive" }] },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.First.parse({ id: "x" })).toEqual({ id: "x" });
    expect(map.First.safeParse({}).success).toBe(false);
    expect(map.Second.safeParse({}).success).toBe(false);
    expect(map.Recursive.safeParse({}).success).toBe(true);

    warnSpy.mockRestore();
  });

  it("falls back to z.unknown() for an empty enum with a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          EmptyEnum: { type: "string", enum: [] },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.EmptyEnum.safeParse(42).success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Empty enum"));
    warnSpy.mockRestore();
  });

  it("degrades reference cycles that never descend into a property or item with a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { map } = convertOpenAPISpecToZodSchemas({
      components: {
        schemas: {
          Alias: { $ref: "#/components/schemas/Alias" },
          Choice: { oneOf: [{ $ref: "#/components/schemas/Choice" }, { type: "string" }] },
          Mixed: { allOf: [{ $ref: "#/components/schemas/Alternative" }] },
          Alternative: { anyOf: [{ $ref: "#/components/schemas/Mixed" }, { type: "string" }] },
        },
      },
    });

    expect(map.Alias.parse(42)).toBe(42);
    expect(map.Choice.parse(false)).toBe(false);
    expect(map.Mixed.parse(null)).toBe(null);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Circular $ref "#/components/schemas/Alias"'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Circular $ref "#/components/schemas/Choice"'));

    warnSpy.mockRestore();
  });

  it("handles oneOf correctly", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          OneOfType: {
            oneOf: [
              { type: "object", properties: { prop: { type: "string" } } },
              { type: "object", properties: { prop: { type: "number" } } },
            ],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.OneOfType.safeParse({ prop: "test" }).success).toBe(true);
    expect(map.OneOfType.safeParse({ prop: 123 }).success).toBe(true);
    expect(map.OneOfType.safeParse({ prop: true }).success).toBe(false);
  });

  it.each([
    { kind: "structured values", values: [{ id: "one" }], input: { id: "one" } },
    { kind: "non-finite numbers", values: [Infinity], input: 1 },
  ])("degrades enums containing $kind with a warning", ({ values, input }) => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { map } = convertOpenAPISpecToZodSchemas({
      components: { schemas: { Choice: { enum: values } } },
    });

    expect(map.Choice.parse(input)).toEqual(input);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unsupported enum member"));

    warnSpy.mockRestore();
  });

  it("handles anyOf correctly", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          AnyOfType: {
            anyOf: [
              { type: "object", properties: { prop1: { type: "string" } }, required: ["prop1"] },
              { type: "object", properties: { prop2: { type: "number" } }, required: ["prop2"] },
            ],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.AnyOfType.safeParse({ prop1: "test" }).success).toBe(true);
    expect(map.AnyOfType.safeParse({ prop2: 123 }).success).toBe(true);
    expect(map.AnyOfType.safeParse({ prop1: "test", prop2: 123 }).success).toBe(true);
    expect(map.AnyOfType.safeParse({}).success).toBe(false);
  });

  it("falls back to z.unknown() for an empty oneOf/anyOf with a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          EmptyUnion: { anyOf: [] },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.EmptyUnion.safeParse("anything").success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Empty oneOf/anyOf"));
    warnSpy.mockRestore();
  });

  it("handles nested schemas correctly", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          NestedType: {
            type: "object",
            properties: {
              nested: {
                type: "object",
                properties: {
                  deepProp: { type: "string" },
                },
                required: ["deepProp"],
              },
            },
            required: ["nested"],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.NestedType.safeParse({ nested: { deepProp: "test" } }).success).toBe(true);
    expect(map.NestedType.safeParse({ nested: {} }).success).toBe(false);
  });

  it("handles array items correctly", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          ArrayType: {
            type: "object",
            properties: {
              arrayProp: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    itemProp: { type: "string" },
                  },
                  required: ["itemProp"],
                },
              },
            },
            required: ["arrayProp"],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.ArrayType.safeParse({ arrayProp: [{ itemProp: "test1" }, { itemProp: "test2" }] }).success).toBe(true);
    expect(map.ArrayType.safeParse({ arrayProp: [{ itemProp: 42 }] }).success).toBe(false);
  });

  it("handles string enums, including single-value enums", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Color: { type: "string", enum: ["red", "green", "blue"] },
          Only: { type: "string", enum: ["only"] },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Color.safeParse("red").success).toBe(true);
    expect(map.Color.safeParse("yellow").success).toBe(false);
    expect(map.Only.safeParse("only").success).toBe(true);
    expect(map.Only.safeParse("other").success).toBe(false);
  });

  it("handles numeric enums instead of degrading to plain numbers", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Status: { type: "integer", enum: [1, 2, 3] },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Status.safeParse(1).success).toBe(true);
    expect(map.Status.safeParse(4).success).toBe(false);
    expect(map.Status.safeParse("1").success).toBe(false);
  });

  it("accepts null for an enum only when the schema is nullable", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Mode: { type: "string", enum: ["auto", "manual"], nullable: true },
          NullableMode: { type: "string", enum: ["auto", null], nullable: true },
          NonNullableMode: { type: "string", enum: ["auto", null] },
          NullOnlyMode: { type: "string", enum: [null], nullable: true },
          ImpossibleMode: { type: "string", enum: [null] },
          UntypedMode: { enum: ["auto", "manual"], nullable: true },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Mode.safeParse("auto").success).toBe(true);
    expect(map.Mode.safeParse(null).success).toBe(true);
    expect(map.Mode.safeParse("off").success).toBe(false);
    expect(map.NullableMode.safeParse(null).success).toBe(true);
    expect(map.NonNullableMode.safeParse(null).success).toBe(false);
    expect(map.NullOnlyMode.safeParse(null).success).toBe(true);
    expect(map.NullOnlyMode.safeParse("auto").success).toBe(false);
    expect(map.ImpossibleMode.safeParse(null).success).toBe(false);
    expect(map.ImpossibleMode.safeParse("auto").success).toBe(false);
    expect(map.UntypedMode.safeParse(null).success).toBe(true);

    warnSpy.mockRestore();
  });

  it("accepts null for a nullable reference and a nullable composition without a type", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Expiration: { type: "object", properties: { days: { type: "integer" } }, required: ["days"] },
          Store: {
            type: "object",
            properties: {
              expires_after: { $ref: "#/components/schemas/Expiration", nullable: true },
              model: { anyOf: [{ type: "string" }, { type: "integer" }], nullable: true },
            },
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Store.safeParse({ expires_after: null, model: null }).success).toBe(true);
    expect(map.Store.safeParse({ expires_after: { days: 7 }, model: "small" }).success).toBe(true);
    expect(map.Store.safeParse({ expires_after: {} }).success).toBe(false);
    expect(map.Store.safeParse({ model: true }).success).toBe(false);
  });

  it("limits enum members to their declared type without repeating the warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Count: { type: "integer", enum: [1, 1.5, 2 ** 53, "1", true] },
          Flag: { type: "boolean", enum: [true, "true", 1] },
          Mixed: { enum: ["text", false, 2, null] },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Count.safeParse(1).success).toBe(true);
    expect(map.Count.safeParse(1.5).success).toBe(false);
    expect(map.Count.safeParse(2 ** 53).success).toBe(false);
    expect(map.Count.safeParse("1").success).toBe(false);
    expect(map.Count.safeParse(true).success).toBe(false);
    expect(map.Flag.safeParse(true).success).toBe(true);
    expect(map.Flag.safeParse("true").success).toBe(false);
    expect(map.Flag.safeParse(1).success).toBe(false);
    expect(map.Mixed.safeParse("text").success).toBe(true);
    expect(map.Mixed.safeParse(false).success).toBe(true);
    expect(map.Mixed.safeParse(2).success).toBe(true);
    expect(map.Mixed.safeParse(null).success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Enum members do not match"));
    expect(warnSpy).toHaveBeenCalledTimes(1);

    warnSpy.mockRestore();
  });

  it("rejects fractional values for integer schemas", () => {
    const { map } = convertOpenAPISpecToZodSchemas({ components: { schemas: { Count: { type: "integer" } } } });

    expect(map.Count.safeParse(1).success).toBe(true);
    expect(map.Count.safeParse(1.5).success).toBe(false);
  });

  it("falls back to z.unknown() for unresolvable $refs with a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Holder: {
            type: "object",
            properties: {
              missing: { $ref: "#/components/schemas/DoesNotExist" },
              nestedPath: { $ref: "#/components/schemas/Holder/properties/missing" },
            },
            required: ["missing"],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Holder.safeParse({ missing: { anything: true }, nestedPath: 42 }).success).toBe(true);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('"DoesNotExist" not found'));
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("Unsupported $ref"));
    warnSpy.mockRestore();
  });

  it("converts additionalProperties-only objects to records", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Dict: { type: "object", additionalProperties: { type: "number" } },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Dict.parse({ a: 1, b: 2 })).toEqual({ a: 1, b: 2 });
    expect(map.Dict.safeParse({ a: "not a number" }).success).toBe(false);
  });

  it("applies additionalProperties as a catchall next to declared properties", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Mixed: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
            additionalProperties: { type: "number" },
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Mixed.parse({ id: "x", extra: 5 })).toEqual({ id: "x", extra: 5 });
    expect(map.Mixed.safeParse({ id: "x", extra: "not a number" }).success).toBe(false);
  });

  it("strips undeclared properties unless additional properties are explicitly allowed", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Open: { type: "object", properties: { id: { type: "string" } } },
          ExplicitOpen: { type: "object", properties: { id: { type: "string" } }, additionalProperties: true },
          FreeForm: { type: "object" },
          Closed: { type: "object", properties: { id: { type: "string" } }, additionalProperties: false },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);
    const value = { id: "x", extra: 5 };
    expect(map.Open.parse(value)).toEqual({ id: "x" });
    expect(map.ExplicitOpen.parse(value)).toEqual(value);
    expect(map.FreeForm.parse(value)).toEqual(value);
    expect(map.Closed.parse({ id: "x" })).toEqual({ id: "x" });
    expect(map.Closed.safeParse(value).success).toBe(false);
  });

  it("rejects additional properties whose schema cannot accept a value", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { map } = convertOpenAPISpecToZodSchemas({
      components: {
        schemas: {
          Settings: {
            type: "object",
            properties: { id: { type: "string" } },
            additionalProperties: { type: "string", enum: [1] },
          },
        },
      },
    });

    expect(map.Settings.parse({ id: "one" })).toEqual({ id: "one" });
    expect(map.Settings.safeParse({ id: "one", extra: "two" }).success).toBe(false);

    warnSpy.mockRestore();
  });

  it("requires undeclared properties and validates them as additional properties", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Required: { type: "object", required: ["uid"] },
          RequiredNumber: { type: "object", required: ["uid"], additionalProperties: { type: "number" } },
          DeclaredUnknown: { type: "object", properties: { uid: {} }, required: ["uid"] },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Required.parse({ uid: null })).toEqual({ uid: null });
    expect(map.Required.safeParse({}).success).toBe(false);
    expect(map.RequiredNumber.parse({ uid: 5 })).toEqual({ uid: 5 });
    expect(map.RequiredNumber.safeParse({}).success).toBe(false);
    expect(map.RequiredNumber.safeParse({ uid: "x" }).success).toBe(false);
    expect(map.DeclaredUnknown.safeParse({}).success).toBe(false);
    expect(map.DeclaredUnknown.parse({ uid: "x" })).toEqual({ uid: "x" });
  });

  it("ignores a required property that a closed object does not declare, with a warning", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { map } = convertOpenAPISpecToZodSchemas({
      components: {
        schemas: {
          RunRequest: {
            type: "object",
            properties: { assistant_id: { type: "string" } },
            required: ["thread_id", "assistant_id"],
            additionalProperties: false,
          },
        },
      },
    });

    expect(map.RunRequest.parse({ assistant_id: "a" })).toEqual({ assistant_id: "a" });
    expect(map.RunRequest.safeParse({}).success).toBe(false);
    expect(map.RunRequest.safeParse({ thread_id: "t", assistant_id: "a" }).success).toBe(false);
    expect(warnSpy.mock.calls).toEqual([
      [
        'Warning: Required property "thread_id" is not declared by an object that forbids additional properties; ignoring the requirement',
      ],
    ]);

    warnSpy.mockRestore();
  });

  it("requires one of the properties named by oneOf members that only list required names", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          FileSearch: {
            type: "object",
            properties: {
              store_ids: { type: "array", items: { type: "string" } },
              stores: { type: "array", items: { type: "string" } },
            },
            oneOf: [{ required: ["store_ids"] }, { required: ["stores"] }],
          },
          ClosedFileSearch: {
            type: "object",
            properties: { store_ids: { type: "string" }, stores: { type: "string" } },
            additionalProperties: false,
            oneOf: [{ required: ["store_ids"] }, { required: ["stores"] }],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.FileSearch.safeParse({}).success).toBe(false);
    expect(map.FileSearch.safeParse({ store_ids: ["one"] }).success).toBe(true);
    expect(map.FileSearch.parse({ stores: ["one"], extra: true })).toEqual({ stores: ["one"] });
    expect(map.ClosedFileSearch.safeParse({ stores: "one" }).success).toBe(true);
    expect(map.ClosedFileSearch.safeParse({ stores: "one", extra: true }).success).toBe(false);
  });

  it("combines the names required by allOf members with those of anyOf members", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Contact: {
            type: "object",
            properties: { id: { type: "string" }, email: { type: "string" }, phone: { type: "string" } },
            allOf: [{ required: ["id"] }],
            anyOf: [{ required: ["email"] }, { required: ["phone"] }],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Contact.safeParse({ id: "one", email: "a@example.com" }).success).toBe(true);
    expect(map.Contact.safeParse({ id: "one", phone: "555" }).success).toBe(true);
    expect(map.Contact.safeParse({ id: "one" }).success).toBe(false);
    expect(map.Contact.safeParse({ email: "a@example.com" }).success).toBe(false);
  });

  it("applies a required-only member beside other composed schemas when the object declares its names", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Account: {
            type: "object",
            properties: { email: { type: "string" } },
            allOf: [{ type: "object", properties: { id: { type: "string" } } }, { required: ["email"] }],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Account.safeParse({ id: "one", email: "a@example.com" }).success).toBe(true);
    expect(map.Account.safeParse({ id: "one" }).success).toBe(false);
  });

  it("converts a schema that declares properties without a type as an object", () => {
    const { map } = convertOpenAPISpecToZodSchemas({
      components: {
        schemas: {
          Model: { properties: { id: { type: "string" } }, required: ["id"] },
          Details: { properties: { reason: { type: "string" } }, nullable: true },
        },
      },
    });

    expect(map.Model.parse({ id: "gpt", extra: 1 })).toEqual({ id: "gpt" });
    expect(map.Model.safeParse({}).success).toBe(false);
    expect(map.Model.safeParse(42).success).toBe(false);
    expect(map.Details.safeParse(null).success).toBe(true);
  });

  it("converts a schema named __proto__ and resolves references to it", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          ["__proto__"]: {
            type: "object",
            properties: { id: { type: "string" } },
            required: ["id"],
          },
          Holder: { $ref: "#/components/schemas/__proto__" },
        },
      },
    };

    const { map, items } = convertOpenAPISpecToZodSchemas(spec);

    expect(items.map(({ name }) => name)).toEqual(["__proto__", "Holder"]);
    expect(map.Holder.safeParse({ id: "x" }).success).toBe(true);
    expect(map.Holder.safeParse({ id: 1 }).success).toBe(false);
    expect(map.Holder.safeParse({}).success).toBe(false);
  });

  it("allows a declared property named __proto__ in a closed object", () => {
    const { map } = convertOpenAPISpecToZodSchemas({
      components: {
        schemas: {
          Item: {
            type: "object",
            properties: { ["__proto__"]: { type: "string" }, id: { type: "string" } },
            required: ["id"],
            additionalProperties: false,
          },
        },
      },
    });

    expect(map.Item.safeParse(JSON.parse('{"__proto__":"x","id":"a"}')).success).toBe(true);
    expect(map.Item.safeParse(JSON.parse('{"__proto__":"x","id":1}')).success).toBe(false);
  });

  it("returns an empty map for a spec without components.schemas", () => {
    const { map, items } = convertOpenAPISpecToZodSchemas({});

    expect(map).toEqual({});
    expect(items).toEqual([]);
  });

  it("handles circular references correctly", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Unit: {
            type: "object",
            properties: {
              uid: { type: "string" },
              parentUnit: { $ref: "#/components/schemas/Unit" },
            },
            required: ["uid"],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    const validUnit = {
      uid: "unit-1",
      parentUnit: {
        uid: "unit-2",
        parentUnit: {
          uid: "unit-3",
        },
      },
    };
    expect(map.Unit.safeParse(validUnit).success).toBe(true);

    const invalidUnit = {
      uid: "unit-1",
      parentUnit: {
        parentUnit: {
          uid: "unit-3",
        },
      },
    };
    expect(map.Unit.safeParse(invalidUnit).success).toBe(false);
  });

  it("handles indirect circular references correctly", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Parent: {
            type: "object",
            properties: {
              name: { type: "string" },
              children: {
                type: "array",
                items: { $ref: "#/components/schemas/Child" },
              },
            },
            required: ["name"],
          },
          Child: {
            type: "object",
            properties: {
              name: { type: "string" },
              parent: { $ref: "#/components/schemas/Parent" },
            },
            required: ["name"],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    const validParent = {
      name: "parent-1",
      children: [
        {
          name: "child-1",
          parent: {
            name: "parent-2",
          },
        },
      ],
    };
    expect(map.Parent.safeParse(validParent).success).toBe(true);

    const validChild = {
      name: "child-1",
      parent: {
        name: "parent-1",
        children: [
          {
            name: "child-2",
          },
        ],
      },
    };
    expect(map.Child.safeParse(validChild).success).toBe(true);

    expect(map.Child.safeParse({ parent: { name: "p" } }).success).toBe(false);
  });

  it("supports required recursive references with nullable termination", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Node: {
            type: "object",
            nullable: true,
            properties: { child: { $ref: "#/components/schemas/Node" } },
            required: ["child"],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);

    expect(map.Node.parse({ child: { child: null } })).toEqual({ child: { child: null } });
    expect(map.Node.safeParse({}).success).toBe(false);
  });

  it("supports required recursive allOf and oneOf properties", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          Node: {
            type: "object",
            nullable: true,
            properties: {
              allOfChild: {
                allOf: [
                  { $ref: "#/components/schemas/Node" },
                  { type: "object", nullable: true, properties: { count: { type: "integer" } } },
                ],
              },
              oneOfChild: { oneOf: [{ $ref: "#/components/schemas/Node" }, { type: "string" }] },
              nestedChild: {
                oneOf: [{ allOf: [{ $ref: "#/components/schemas/Node" }] }, { type: "string" }],
              },
            },
            required: ["allOfChild", "oneOfChild"],
          },
        },
      },
    };

    const { map } = convertOpenAPISpecToZodSchemas(spec);
    const value = {
      allOfChild: { allOfChild: null, oneOfChild: "end", count: 1 },
      oneOfChild: { allOfChild: null, oneOfChild: null },
      nestedChild: { allOfChild: null, oneOfChild: null },
    };
    expect(map.Node.parse(value)).toEqual(value);
    expect(map.Node.safeParse({ allOfChild: null }).success).toBe(false);
    expect(map.Node.safeParse({ oneOfChild: null }).success).toBe(false);
    expect(
      map.Node.safeParse({ allOfChild: { allOfChild: null, oneOfChild: null, count: "1" }, oneOfChild: null }).success
    ).toBe(false);
  });
});
