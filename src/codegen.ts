/* eslint-disable sonarjs/no-nested-template-literals */
import { z } from "zod";
import { OpenAPISpec, OpenAPIToZodConverter } from "./converter";

interface ZodLazyDef {
  getter: () => z.ZodTypeAny;
}

interface ZodUnionDef {
  options: z.ZodTypeAny[];
}

interface ZodEnumDef {
  values: string[];
}

interface ZodLiteralDef {
  value: boolean | number | string;
}

interface ZodSchemaWithDef<T> {
  _def: T;
}

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
      const unionSchema = schema as ZodSchemaWithDef<ZodUnionDef>;
      const options = unionSchema._def.options;
      return `z.union([${options
        .map((opt: z.ZodTypeAny, index: number) => this.generateSchemaCode(opt, `${schemaName}.union.${index}`))
        .join(", ")}])`;
    } else if (schema instanceof z.ZodString) {
      let result = "z.string()";
      for (const check of schema._def.checks) {
        switch (check.kind) {
          case "min": {
            result += `.min(${check.value})`;
            break;
          }
          case "max": {
            result += `.max(${check.value})`;
            break;
          }
          case "date": {
            result += `.date()`;
            break;
          }
          default:
            throw new Error(`unsupported check kind: ${check.kind}`);
        }
      }
      return result;
    } else if (schema instanceof z.ZodNumber) {
      return "z.number()";
    } else if (schema instanceof z.ZodBoolean) {
      return "z.boolean()";
    } else if (schema instanceof z.ZodEnum) {
      const enumSchema = schema as ZodSchemaWithDef<ZodEnumDef>;
      const values = enumSchema._def.values;
      if (values.length === 1) {
        return `z.literal("${values[0]}")`;
      }
      return `z.enum([${values.map((v: string) => `"${v}"`).join(", ")}])`;
    } else if (schema instanceof z.ZodLiteral) {
      const literalSchema = schema as ZodSchemaWithDef<ZodLiteralDef>;
      const value = literalSchema._def.value;
      return `z.literal(${typeof value === "string" ? `"${value}"` : value})`;
    } else if (schema instanceof z.ZodNullable) {
      return `${this.generateSchemaCode(schema.unwrap(), schemaName)}.nullable()`;
    } else if (schema instanceof z.ZodOptional) {
      return `${this.generateSchemaCode(schema.unwrap(), schemaName)}.optional()`;
    } else if (schema instanceof z.ZodLazy) {
      const referencedName = Object.entries(this.schemas).find(([, s]) => s === schema)?.[0];
      if (referencedName) {
        if (this.currentlyGenerating.has(referencedName)) {
          return `z.lazy(() => ${this.prefix}${referencedName}Schema)`;
        }
        return `${this.prefix}${referencedName}Schema`;
      }
      const lazySchema = schema as ZodSchemaWithDef<ZodLazyDef>;
      return `z.lazy(() => ${this.generateSchemaCode(lazySchema._def.getter(), schemaName)})`;
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
        let schemaCode: string;
        if (schema instanceof z.ZodLazy) {
          const lazySchema = schema as ZodSchemaWithDef<ZodLazyDef>;
          schemaCode = this.generateSchemaCode(lazySchema._def.getter(), name);
        } else {
          schemaCode = this.generateSchemaCode(schema, name);
        }
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
