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

  private guessDiscriminatorPropertyName(schemas: z.ZodTypeAny[]): string | undefined {
    let possibleFieldNames = schemas.reduce((possibleFieldNames: string[] | undefined, schema) => {
      if (schema instanceof z.ZodLazy) {
        const referencedName = Object.entries(this.schemas).find(([, s]) => s === schema)?.[0];
        if (referencedName) {
          if (!this.currentlyGenerating.has(referencedName)) {
            //analyze already exported schema
            schema = schema.schema;
          }
        }
      }
      if (!(schema instanceof z.ZodObject)) return [];
      let keys = Object.keys(schema.shape);
      let literalFieldNames = keys.filter((key) => schema.shape[key] instanceof z.ZodLiteral);
      if (possibleFieldNames === undefined) return literalFieldNames;
      return possibleFieldNames.filter((fieldName) => literalFieldNames.includes(fieldName));
    }, undefined);
    if (possibleFieldNames && possibleFieldNames.length > 0) return possibleFieldNames[0];
    return undefined;
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

      let discriminatorPropertyName = this.guessDiscriminatorPropertyName(options);
      if (discriminatorPropertyName) {
        return `z.discriminatedUnion("${discriminatorPropertyName}", [${options
          .map((opt: z.ZodTypeAny, index: number) => this.generateSchemaCode(opt, `${schemaName}.union.${index}`))
          .join(", ")}])`;
      }
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
        if (!this.generatedSchemas.has(referencedName)) {
          return `z.lazy(() => ${this.prefix}${referencedName}Schema)`;
        }
        return `${this.prefix}${referencedName}Schema`;
      }
      const lazySchema = schema as ZodSchemaWithDef<ZodLazyDef>;
      return `z.lazy(() => ${this.generateSchemaCode(lazySchema._def.getter(), schemaName)})`;
    }
    return "z.unknown()";
  }

  getReferencingSchemaNames(schema: z.ZodTypeAny): string[] {
    let me = this;
    function extractSchemaNames(schema: z.ZodTypeAny): string[] {
      const result: string[] = [];
      if (schema instanceof z.ZodObject) {
        const shape = schema.shape;
        return Object.entries(shape)
          .map(([key, value]) => extractSchemaNames(value as z.ZodTypeAny))
          .flat();
      } else if (schema instanceof z.ZodArray) {
        return extractSchemaNames(schema.element);
      } else if (schema instanceof z.ZodUnion) {
        const unionSchema = schema as ZodSchemaWithDef<ZodUnionDef>;
        const options = unionSchema._def.options;
        return options.map((schema) => extractSchemaNames(schema)).flat();
      } else if (schema instanceof z.ZodNullable) {
        return extractSchemaNames(schema.unwrap());
      } else if (schema instanceof z.ZodOptional) {
        return extractSchemaNames(schema.unwrap());
      } else if (schema instanceof z.ZodLazy) {
        const referencedName = Object.entries(me.schemas).find(([, s]) => s === schema)?.[0];
        if (referencedName) {
          return [referencedName];
        }
        const lazySchema = schema as ZodSchemaWithDef<ZodLazyDef>;
        return extractSchemaNames(lazySchema._def.getter());
      }
      return result;
    }

    if (schema instanceof z.ZodLazy) {
      const lazySchema = schema as ZodSchemaWithDef<ZodLazyDef>;
      return extractSchemaNames(lazySchema._def.getter());
    } else {
      return extractSchemaNames(schema);
    }
  }

  generateSchemaSequenceFrom(dependencyMap: Map<string, string[]>): string[] {
    let result: string[] = [];

    function processElement(targetPosition: number, name: string) {
      let depdendencies = dependencyMap.get(name);
      if (depdendencies == undefined) {
        return 0;
      }
      dependencyMap.delete(name);
      result.splice(targetPosition, 0, name);
      let insertedElementCount = 0;
      for (let dependency of depdendencies) {
        let insertedElementCountByDependency = processElement(targetPosition, dependency);
        targetPosition += insertedElementCountByDependency;
        insertedElementCount += insertedElementCountByDependency;
      }
      return insertedElementCount + 1;
    }

    while (true) {
      let first_entry = dependencyMap.entries().next();
      if (first_entry.done) {
        return result;
      }
      const [name] = first_entry.value;
      processElement(result.length, name);
    }
  }

  generateCode(): string {
    const imports = `import { z } from 'zod';\n\n`;
    const schemasToGenerate = this.generateSchemaSequenceFrom(
      Object.entries(this.schemas).reduce((dependencyMap, [name, schema]) => {
        dependencyMap.set(name, this.getReferencingSchemaNames(schema));
        return dependencyMap;
      }, new Map<string, string[]>())
    );
    const schemaDefinitions = schemasToGenerate
      .map((name) => [name, this.schemas[name]] as [string, z.ZodTypeAny])
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
