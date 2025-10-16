/* eslint-disable @typescript-eslint/class-methods-use-this */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { z } from "zod";

interface OpenAPISchemaBase {
  type?: string;
  nullable?: boolean;
  enum?: string[];
}

interface OpenAPISchemaObject extends OpenAPISchemaBase {
  type: "object";
  properties?: Record<string, OpenAPISchema | undefined>;
  required?: string[];
}

interface OpenAPISchemaArray extends OpenAPISchemaBase {
  type: "array";
  items?: OpenAPISchema | undefined;
}

interface OpenAPISchemaAllOf {
  allOf: OpenAPISchema[];
}

interface OpenAPISchemaOneOf {
  oneOf: OpenAPISchema[];
}

interface OpenAPISchemaAnyOf {
  anyOf: OpenAPISchema[];
}

interface OpenAPISchemaRef {
  $ref: string;
}

type OpenAPISchema =
  | OpenAPISchemaAllOf
  | OpenAPISchemaAnyOf
  | OpenAPISchemaArray
  | OpenAPISchemaBase
  | OpenAPISchemaObject
  | OpenAPISchemaOneOf
  | OpenAPISchemaRef;

interface OpenAPISpec {
  components: {
    schemas: Record<string, OpenAPISchema | undefined>;
  };
}

const isRefSchema = (schema: OpenAPISchema): schema is OpenAPISchemaRef => "$ref" in schema;
const isAllOfSchema = (schema: OpenAPISchema): schema is OpenAPISchemaAllOf => "allOf" in schema;
const isOneOfSchema = (schema: OpenAPISchema): schema is OpenAPISchemaOneOf => "oneOf" in schema;
const isAnyOfSchema = (schema: OpenAPISchema): schema is OpenAPISchemaAnyOf => "anyOf" in schema;
const isObjectSchema = (schema: OpenAPISchema): schema is OpenAPISchemaObject =>
  "type" in schema && schema.type === "object";
const isArraySchema = (schema: OpenAPISchema): schema is OpenAPISchemaArray =>
  "type" in schema && schema.type === "array";
const isStringSchema = (schema: OpenAPISchema): schema is OpenAPISchemaBase =>
  "type" in schema && schema.type === "string";
const isNumberSchema = (schema: OpenAPISchema): schema is OpenAPISchemaBase =>
  "type" in schema && (schema.type === "number" || schema.type === "integer");
const isBooleanSchema = (schema: OpenAPISchema): schema is OpenAPISchemaBase =>
  "type" in schema && schema.type === "boolean";

class OpenAPIToZodConverter {
  private spec: OpenAPISpec;
  private zodSchemas: Record<string, z.ZodTypeAny> = {};

  constructor(spec: OpenAPISpec) {
    this.spec = spec;
  }

  private convertSchema(schema: OpenAPISchema): z.ZodTypeAny {
    if (isRefSchema(schema)) return this.handleRef(schema.$ref);
    if (isAllOfSchema(schema)) return this.handleAllOf(schema.allOf);
    if (isAnyOfSchema(schema)) return this.handleAnyOf(schema.anyOf);
    // who the fuck thought having oneOf and anyOf was a good decision for schema design?
    if (isOneOfSchema(schema)) return this.handleAnyOf(schema.oneOf);
    if (isObjectSchema(schema)) return this.convertObjectSchema(schema);
    if (isArraySchema(schema)) return this.convertArraySchema(schema);
    if (isStringSchema(schema)) return this.convertStringSchema(schema);
    if (isNumberSchema(schema)) return this.convertNumberSchema(schema);
    if (isBooleanSchema(schema)) return this.convertBooleanSchema(schema);
    return z.unknown();
  }

  private handleAllOf(schemas: OpenAPISchema[]): z.ZodTypeAny {
    const mergedSchema: OpenAPISchemaObject = {
      type: "object",
      properties: {},
      required: [],
    };

    for (const schema of schemas) {
      if (isObjectSchema(schema)) {
        if (schema.properties) {
          mergedSchema.properties = { ...mergedSchema.properties, ...schema.properties };
        }
        if (schema.required) {
          mergedSchema.required = [...(mergedSchema.required ?? []), ...schema.required];
        }
      }
    }

    return this.convertObjectSchema(mergedSchema);
  }

  private handleAnyOf(schemas: OpenAPISchema[]): z.ZodTypeAny {
    const convertedSchemas = schemas.map((s) => this.convertSchema(s));
    if (convertedSchemas.length == 0) {
      return z.never();
    }
    if (convertedSchemas.length === 1) {
      return convertedSchemas[0];
    }
    return z.union(convertedSchemas as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]]);
  }

  private handleRef(ref: string): z.ZodTypeAny {
    const schemaName = ref.split("/").pop() as string;
    if (!this.zodSchemas[schemaName]) {
      const refSchema = this.spec.components.schemas[schemaName];
      if (!refSchema) {
        console.warn(`Warning: Referenced schema "${schemaName}" not found in spec`);
        return z.unknown();
      }
      this.zodSchemas[schemaName] = z.lazy(() => this.convertSchema(refSchema));
    }
    return this.zodSchemas[schemaName];
  }

  private convertObjectSchema(schema: OpenAPISchemaObject): z.ZodTypeAny {
    const shape: Record<string, z.ZodTypeAny> = {};
    const requiredFields = new Set(schema.required ?? []);

    for (const [key, value] of Object.entries(schema.properties ?? {})) {
      if (value) {
        const fieldSchema = this.convertSchema(value);
        shape[key] = requiredFields.has(key) ? fieldSchema : fieldSchema.optional();
      }
    }

    const objectSchema = z.object(shape);
    return schema.nullable ? objectSchema.nullable() : objectSchema;
  }

  private convertArraySchema(schema: OpenAPISchemaArray): z.ZodTypeAny {
    const itemSchema = schema.items ? this.convertSchema(schema.items) : z.unknown();
    const arraySchema = z.array(itemSchema);
    return schema.nullable ? arraySchema.nullable() : arraySchema;
  }

  private convertStringSchema(schema: OpenAPISchemaBase): z.ZodTypeAny {
    if (schema.enum) {
      if (schema.enum.length === 1) {
        return z.literal(schema.enum[0]);
      }
      return z.enum(schema.enum as [string, ...string[]]);
    }
    const stringSchema = z.string();
    return schema.nullable ? stringSchema.nullable() : stringSchema;
  }

  private convertNumberSchema(schema: OpenAPISchemaBase): z.ZodTypeAny {
    const numberSchema = z.number();
    return schema.nullable ? numberSchema.nullable() : numberSchema;
  }

  private convertBooleanSchema(schema: OpenAPISchemaBase): z.ZodTypeAny {
    return schema.nullable ? z.boolean().nullable() : z.boolean();
  }

  public convert(): Record<string, z.ZodTypeAny> {
    for (const [name, schema] of Object.entries(this.spec.components.schemas)) {
      if (schema) {
        this.zodSchemas[name] = z.lazy(() => this.convertSchema(schema));
      }
    }
    return this.zodSchemas;
  }
}

export function convertOpenAPISpecToZodSchemas(spec: OpenAPISpec) {
  const converter = new OpenAPIToZodConverter(spec);
  const map = converter.convert();
  return {
    map,
    items: Object.entries(map).map(([name, schema]) => ({ name, schema })),
  };
}

export { type OpenAPISpec, OpenAPIToZodConverter };
