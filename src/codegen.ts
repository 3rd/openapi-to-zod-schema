/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable sonarjs/no-nested-template-literals */
import { z } from "zod";
import { OpenAPISpec, OpenAPIToZodConverter } from "./converter";

const indent = (code: string, level = 1) => {
  const spaces = "  ".repeat(level);
  return code
    .split("\n")
    .map((line) => spaces + line)
    .join("\n");
};

const formatObjectKey = (key: string) => {
  if (/^[$A-Z_a-z][\w$]*$/.test(key)) {
    return key;
  }
  return `"${key}"`;
};

class ZodSchemaCodeGenerator {
  private schemas: Record<string, z.ZodTypeAny>;
  private generatedSchemas: Set<string>;
  private currentlyGenerating: Set<string>;
  private prefix: string;

  constructor(schemas: Record<string, z.ZodTypeAny>, prefix = "") {
    this.schemas = schemas;
    this.generatedSchemas = new Set();
    this.currentlyGenerating = new Set();
    this.prefix = prefix;
  }

  private generateSchemaCode(schema: z.ZodTypeAny, schemaName: string): string {
    const referencedSchemaName = Object.entries(this.schemas).find(([, s]) => s === schema)?.[0];
    if (
      referencedSchemaName &&
      this.generatedSchemas.has(referencedSchemaName) &&
      !this.currentlyGenerating.has(referencedSchemaName)
    ) {
      return `${this.prefix}${referencedSchemaName}Schema`;
    }

    if (schema instanceof z.ZodObject) {
      const shape = schema.shape;
      const properties = Object.entries(shape)
        .map(
          ([key, value]) =>
            `${formatObjectKey(key)}: ${this.generateSchemaCode(value as z.ZodTypeAny, `${schemaName}.${key}`)}`
        )
        .join(",\n");
      return `z.object({\n${indent(properties)}\n})`;
    } else if (schema instanceof z.ZodArray) {
      return `z.array(${this.generateSchemaCode(schema.element, `${schemaName}.element`)})`;
    } else if (schema instanceof z.ZodUnion) {
      const options = (schema as any)._def.options;
      return `z.union([${options
        .map((opt: z.ZodTypeAny, index: number) => this.generateSchemaCode(opt, `${schemaName}.union.${index}`))
        .join(", ")}])`;
    } else if (schema instanceof z.ZodString) {
      return "z.string()";
    } else if (schema instanceof z.ZodNumber) {
      return "z.number()";
    } else if (schema instanceof z.ZodBoolean) {
      return "z.boolean()";
    } else if (schema instanceof z.ZodEnum) {
      const values = (schema as any)._def.values;
      if (values.length === 1) {
        return `z.literal("${values[0]}")`;
      }
      return `z.enum([${values.map((v: string) => `"${v}"`).join(", ")}])`;
    } else if (schema instanceof z.ZodLiteral) {
      const value = (schema as any)._def.value;
      return `z.literal(${typeof value === "string" ? `"${value}"` : value})`;
    } else if (schema instanceof z.ZodNullable) {
      return `${this.generateSchemaCode(schema.unwrap(), schemaName)}.nullable()`;
    } else if (schema instanceof z.ZodOptional) {
      return `${this.generateSchemaCode(schema.unwrap(), schemaName)}.optional()`;
    } else if (schema instanceof z.ZodLazy) {
      const originalSchemaName = Object.keys(this.schemas).find(
        (key) => this.schemas[key] === (schema as any)._def.getter()
      );
      if (
        originalSchemaName &&
        this.generatedSchemas.has(originalSchemaName) &&
        !this.currentlyGenerating.has(originalSchemaName)
      ) {
        return `${originalSchemaName}Schema`;
      }
      return this.generateSchemaCode((schema as any)._def.getter(), schemaName);
    }
    return "z.unknown()";
  }

  generateCode(): string {
    const imports = `import { z } from 'zod';\n\n`;
    const schemaDefinitions = Object.entries(this.schemas)
      .map(([name, schema]) => {
        if (this.currentlyGenerating.has(name)) {
          return "";
        }
        this.currentlyGenerating.add(name);
        const schemaCode = this.generateSchemaCode(schema, name);
        this.currentlyGenerating.delete(name);
        this.generatedSchemas.add(name);
        return `export const ${this.prefix}${name}Schema = ${schemaCode};`;
      })
      .filter(Boolean)
      .join("\n\n");
    return imports + schemaDefinitions;
  }
}

export const codegen = (spec: OpenAPISpec, prefix = "") => {
  const converter = new OpenAPIToZodConverter(spec);
  const zodSchemas = converter.convert();
  const codeGenerator = new ZodSchemaCodeGenerator(zodSchemas, prefix);
  return codeGenerator.generateCode();
};
