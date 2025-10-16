import { z, ZodStringDef } from "zod";
import { convertOpenAPISpecToZodSchemas, OpenAPISpec } from "./converter";

const unwrapLazy = <T extends z.ZodTypeAny>(schema: z.ZodLazy<T>): T => {
  const lazySchema = schema as unknown as { _def: { getter: () => T } };
  return lazySchema._def.getter();
};

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

    const zodSchemas = convertOpenAPISpecToZodSchemas(spec);
    const BasicTypesSchemaLazy = zodSchemas.map.BasicTypes as z.ZodLazy<z.ZodObject<z.ZodRawShape>>;
    const BasicTypesSchema = unwrapLazy(BasicTypesSchemaLazy);

    // test that the schema is wrapped in lazy
    expect(BasicTypesSchemaLazy).toBeInstanceOf(z.ZodLazy);

    // test schema structure
    expect(BasicTypesSchema.shape.stringProp).toBeInstanceOf(z.ZodString);
    expect(BasicTypesSchema.shape.numberProp).toBeInstanceOf(z.ZodNumber);
    expect(BasicTypesSchema.shape.integerProp).toBeInstanceOf(z.ZodNumber);
    expect(BasicTypesSchema.shape.booleanProp).toBeInstanceOf(z.ZodBoolean);
    expect(BasicTypesSchema.shape.arrayProp).toBeInstanceOf(z.ZodArray);

    const parsed = BasicTypesSchemaLazy.safeParse({
      stringProp: "test",
      numberProp: 123,
      integerProp: 456,
      booleanProp: true,
      arrayProp: ["a", "b", "c"],
    });

    expect(parsed.success).toBe(true);
  });

  it("converts string validations correctly", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          BasicTypes: {
            type: "object",
            properties: {
              stringProp: { type: "string", minLength: 1, maxLength: 5 },
            },
            required: ["stringProp"],
          },
        },
      },
    };

    const zodSchemas = convertOpenAPISpecToZodSchemas(spec);
    const StringTypesSchemaLazy = zodSchemas.map.BasicTypes as z.ZodLazy<z.ZodObject<z.ZodRawShape>>;
    const StringTypesSchema = unwrapLazy(StringTypesSchemaLazy);

    // test that the schema is wrapped in lazy
    expect(StringTypesSchemaLazy).toBeInstanceOf(z.ZodLazy);

    // test schema structure
    expect(StringTypesSchema.shape.stringProp).toBeInstanceOf(z.ZodString);
    const checks = (StringTypesSchema.shape.stringProp._def as ZodStringDef).checks;
    expect(checks).toContainEqual({ kind: "min", value: 1 });
    expect(checks).toContainEqual({ kind: "max", value: 5 });

    const parsed = StringTypesSchemaLazy.safeParse({
      stringProp: "test",
    });
    expect(parsed.success).toBe(true);
    const invalidMinLengthParsed = StringTypesSchemaLazy.safeParse({
      stringProp: "",
    });
    expect(invalidMinLengthParsed.success).toBe(false);

    const invalidMaxLengthParsed = StringTypesSchemaLazy.safeParse({
      stringProp: "longtest",
    });
    expect(invalidMaxLengthParsed.success).toBe(false);
  });

  it("converts string formatted date validations correctly", () => {
    const spec: OpenAPISpec = {
      components: {
        schemas: {
          BasicTypes: {
            type: "object",
            properties: {
              stringProp: { type: "string", format: "date" },
            },
            required: ["stringProp"],
          },
        },
      },
    };

    const zodSchemas = convertOpenAPISpecToZodSchemas(spec);
    const StringTypesSchemaLazy = zodSchemas.map.BasicTypes as z.ZodLazy<z.ZodObject<z.ZodRawShape>>;
    const StringTypesSchema = unwrapLazy(StringTypesSchemaLazy);

    // test that the schema is wrapped in lazy
    expect(StringTypesSchemaLazy).toBeInstanceOf(z.ZodLazy);

    // test schema structure
    expect(StringTypesSchema.shape.stringProp).toBeInstanceOf(z.ZodString);
    const checks = (StringTypesSchema.shape.stringProp._def as ZodStringDef).checks;
    expect(checks).toContainEqual({ kind: "date" });

    const parsed = StringTypesSchemaLazy.safeParse({
      stringProp: "1970-01-01",
    });
    expect(parsed.success).toBe(true);
    const invalidDateParsed = StringTypesSchemaLazy.safeParse({
      stringProp: "70-1-1",
    });
    expect(invalidDateParsed.success).toBe(false);
  });

  it("handles $ref correctly", () => {
    const spec = {
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

    const zodSchemas = convertOpenAPISpecToZodSchemas(spec);
    const MainTypeSchemaLazy = zodSchemas.map.MainType as z.ZodLazy<z.ZodObject<z.ZodRawShape>>;
    const MainTypeSchema = unwrapLazy(MainTypeSchemaLazy);

    expect(MainTypeSchemaLazy).toBeInstanceOf(z.ZodLazy);
    expect(MainTypeSchema.shape.refProp).toBeInstanceOf(z.ZodLazy);

    const parsed = MainTypeSchemaLazy.safeParse({
      refProp: { prop: "test" },
    });

    expect(parsed.success).toBe(true);
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

    const zodSchemas = convertOpenAPISpecToZodSchemas(spec);
    const AllOfTypeSchemaLazy = zodSchemas.map.AllOfType as z.ZodLazy<z.ZodObject<z.ZodRawShape>>;
    const AllOfTypeSchema = unwrapLazy(AllOfTypeSchemaLazy);

    expect(AllOfTypeSchemaLazy).toBeInstanceOf(z.ZodLazy);
    expect(AllOfTypeSchema.shape.prop1).toBeInstanceOf(z.ZodString);
    expect(AllOfTypeSchema.shape.prop2).toBeInstanceOf(z.ZodNumber);

    const parsed = AllOfTypeSchemaLazy.safeParse({
      prop1: "test",
      prop2: 123,
    });

    expect(parsed.success).toBe(true);

    const invalidParsed = AllOfTypeSchemaLazy.safeParse({
      prop2: 123,
    });

    expect(invalidParsed.success).toBe(false);
  });

  it("handles oneOf correctly", () => {
    const spec = {
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

    const zodSchemas = convertOpenAPISpecToZodSchemas(spec);
    const OneOfTypeSchemaLazy = zodSchemas.map.OneOfType as z.ZodLazy<z.ZodUnion<[z.ZodTypeAny, z.ZodTypeAny]>>;
    const OneOfTypeSchema = unwrapLazy(OneOfTypeSchemaLazy);

    expect(OneOfTypeSchemaLazy).toBeInstanceOf(z.ZodLazy);
    expect(OneOfTypeSchema).toBeInstanceOf(z.ZodUnion);

    const parsedString = OneOfTypeSchemaLazy.safeParse({ prop: "test" });
    const parsedNumber = OneOfTypeSchemaLazy.safeParse({ prop: 123 });

    expect(parsedString.success).toBe(true);
    expect(parsedNumber.success).toBe(true);
  });

  it("handles anyOf correctly", () => {
    const spec = {
      components: {
        schemas: {
          AnyOfType: {
            anyOf: [
              { type: "object", properties: { prop1: { type: "string" } } },
              { type: "object", properties: { prop2: { type: "number" } } },
            ],
          },
        },
      },
    };

    const zodSchemas = convertOpenAPISpecToZodSchemas(spec);
    const AnyOfTypeSchemaLazy = zodSchemas.map.AnyOfType as z.ZodLazy<z.ZodUnion<[z.ZodTypeAny, z.ZodTypeAny]>>;
    const AnyOfTypeSchema = unwrapLazy(AnyOfTypeSchemaLazy);

    expect(AnyOfTypeSchemaLazy).toBeInstanceOf(z.ZodLazy);
    expect(AnyOfTypeSchema).toBeInstanceOf(z.ZodUnion);

    const parsed1 = AnyOfTypeSchemaLazy.safeParse({ prop1: "test" });
    const parsed2 = AnyOfTypeSchemaLazy.safeParse({ prop2: 123 });
    const parsedBoth = AnyOfTypeSchemaLazy.safeParse({ prop1: "test", prop2: 123 });

    expect(parsed1.success).toBe(true);
    expect(parsed2.success).toBe(true);
    expect(parsedBoth.success).toBe(true);
  });

  it("handles nested schemas correctly", () => {
    const spec = {
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

    const zodSchemas = convertOpenAPISpecToZodSchemas(spec);
    const NestedTypeSchemaLazy = zodSchemas.map.NestedType as z.ZodLazy<z.ZodObject<z.ZodRawShape>>;
    const NestedTypeSchema = unwrapLazy(NestedTypeSchemaLazy);

    expect(NestedTypeSchemaLazy).toBeInstanceOf(z.ZodLazy);
    expect(NestedTypeSchema.shape.nested).toBeInstanceOf(z.ZodObject);
    expect((NestedTypeSchema.shape.nested as z.ZodObject<z.ZodRawShape>).shape.deepProp).toBeInstanceOf(z.ZodString);

    const parsed = NestedTypeSchemaLazy.safeParse({
      nested: { deepProp: "test" },
    });

    expect(parsed.success).toBe(true);
  });

  it("handles array items correctly", () => {
    const spec = {
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
                },
              },
            },
            required: ["arrayProp"],
          },
        },
      },
    };

    const zodSchemas = convertOpenAPISpecToZodSchemas(spec);
    const ArrayTypeSchemaLazy = zodSchemas.map.ArrayType as z.ZodLazy<z.ZodObject<z.ZodRawShape>>;
    const ArrayTypeSchema = unwrapLazy(ArrayTypeSchemaLazy);

    expect(ArrayTypeSchemaLazy).toBeInstanceOf(z.ZodLazy);
    expect(ArrayTypeSchema.shape.arrayProp).toBeInstanceOf(z.ZodArray);

    const parsed = ArrayTypeSchemaLazy.safeParse({
      arrayProp: [{ itemProp: "test1" }, { itemProp: "test2" }],
    });

    expect(parsed.success).toBe(true);
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

    const zodSchemas = convertOpenAPISpecToZodSchemas(spec);
    const UnitSchema = zodSchemas.map.Unit;

    const validUnit = {
      uid: "unit-1",
      parentUnit: {
        uid: "unit-2",
        parentUnit: {
          uid: "unit-3",
        },
      },
    };

    const parsed = UnitSchema.safeParse(validUnit);
    expect(parsed.success).toBe(true);

    const invalidUnit = {
      uid: "unit-1",
      parentUnit: {
        parentUnit: {
          uid: "unit-3",
        },
      },
    };

    const invalidParsed = UnitSchema.safeParse(invalidUnit);
    expect(invalidParsed.success).toBe(false);
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

    const zodSchemas = convertOpenAPISpecToZodSchemas(spec);
    const ParentSchema = zodSchemas.map.Parent;
    const ChildSchema = zodSchemas.map.Child;

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

    const parsedParent = ParentSchema.safeParse(validParent);
    expect(parsedParent.success).toBe(true);

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

    const parsedChild = ChildSchema.safeParse(validChild);
    expect(parsedChild.success).toBe(true);
  });
});
