import { z } from "zod";
import { type OpenAPISpec, OpenAPIToZodConverter } from "./converter.ts";

const VALID_IDENTIFIER_PATTERN = /^[$_\p{ID_Start}][$_\u200c\u200d\p{ID_Continue}]*$/u;

const indent = (code: string, level = 1) => {
  const spaces = "  ".repeat(level);
  return code
    .split("\n")
    .map((line) => spaces + line)
    .join("\n");
};

const formatObjectKey = (key: string) => {
  if (key === "__proto__") return `[${JSON.stringify(key)}]`;

  if (VALID_IDENTIFIER_PATTERN.test(key)) {
    return key;
  }
  return JSON.stringify(key);
};

const sanitizeIdentifier = (name: string) => {
  const cleaned = name.replace(/[^$_\u200c\u200d\p{ID_Continue}]/gu, "_");
  if (!VALID_IDENTIFIER_PATTERN.test(`${cleaned}Schema`)) return `_${cleaned}`;

  return cleaned;
};

class ZodSchemaCodeGenerator {
  private schemas: Record<string, z.ZodType>;
  private nameBySchema: Map<z.core.$ZodType, string>;
  private identifierByName: Record<string, string>;
  private generatedSchemas: Set<string>;
  private currentlyGenerating: Set<string>;

  constructor(schemas: Record<string, z.ZodType>, prefix = "") {
    this.schemas = schemas;
    this.generatedSchemas = new Set();
    this.currentlyGenerating = new Set();

    this.nameBySchema = new Map(Object.entries(schemas).map(([name, schema]) => [schema, name]));
    const names = Object.keys(schemas);
    const validIdentifiers = names
      .map((name) => `${prefix}${name}`)
      .filter((name) => VALID_IDENTIFIER_PATTERN.test(`${name}Schema`));
    const usedIdentifiers = new Set(validIdentifiers);
    const nextSuffixByBase = new Map<string, number>();
    this.identifierByName = Object.fromEntries(
      names.map((name) => {
        const combined = `${prefix}${name}`;
        if (VALID_IDENTIFIER_PATTERN.test(`${combined}Schema`)) return [name, combined];

        const base = sanitizeIdentifier(combined);
        let candidate = base;
        let suffix = nextSuffixByBase.get(base) ?? 2;

        while (usedIdentifiers.has(candidate)) {
          candidate = `${base}${suffix++}`;
        }

        usedIdentifiers.add(candidate);
        nextSuffixByBase.set(base, suffix);

        return [name, candidate];
      })
    );
  }

  private schemaConstName(name: string): string {
    return `${this.identifierByName[name]}Schema`;
  }

  private guessDiscriminatorPropertyName(schemas: readonly z.core.$ZodType[]): string | undefined {
    const objectSchemas: z.ZodObject<z.core.$ZodShape>[] = [];

    for (let schema of schemas) {
      if (schema instanceof z.ZodLazy) {
        const referencedName = this.nameBySchema.get(schema);
        if (!referencedName) return undefined;
        if (!this.generatedSchemas.has(referencedName)) return undefined;

        schema = schema.unwrap();
      }
      if (!(schema instanceof z.ZodObject)) return undefined;

      objectSchemas.push(schema);
    }

    for (const fieldName of Object.keys(objectSchemas[0].shape)) {
      // Zod skips a property named "__proto__" when it parses an object. A discriminated union on that name would
      // still demand one of its literals and reject input that the plain union of the same objects accepts.
      if (fieldName === "__proto__") continue;

      const values = new Set<unknown>();

      const hasDistinctLiterals = objectSchemas.every((schema) => {
        const fieldSchema = schema.shape[fieldName];
        if (!(fieldSchema instanceof z.ZodLiteral)) return false;

        const [value] = fieldSchema.values;
        if (values.has(value)) return false;

        values.add(value);

        return true;
      });
      if (hasDistinctLiterals) return fieldName;
    }

    return undefined;
  }

  private generateSchemaCode(
    schema: z.core.$ZodType,
    schemaName: string,
    references: "inline" | "lazy" = "inline"
  ): string {
    if (schema instanceof z.ZodObject) {
      return this.generateObjectCode(schema, schemaName);
    } else if (schema instanceof z.ZodRecord) {
      return `z.record(z.string(), ${this.generateSchemaCode(schema.valueType, `${schemaName}.record`)})`;
    } else if (schema instanceof z.ZodArray) {
      return `z.array(${this.generateSchemaCode(schema.element, `${schemaName}.element`)})`;
    } else if (schema instanceof z.ZodIntersection) {
      const leftCode = this.generateSchemaCode(schema.def.left, `${schemaName}.left`);
      const rightCode = this.generateSchemaCode(schema.def.right, `${schemaName}.right`);

      return `z.intersection(${leftCode}, ${rightCode})`;
    } else if (schema instanceof z.ZodUnion) {
      const { options } = schema;

      const discriminatorPropertyName = this.guessDiscriminatorPropertyName(options);
      if (discriminatorPropertyName) {
        return `z.discriminatedUnion(${JSON.stringify(discriminatorPropertyName)}, [${options
          .map((option, index) => this.generateSchemaCode(option, `${schemaName}.union.${index}`))
          .join(", ")}])`;
      }
      return `z.union([${options
        .map((option, index) => this.generateSchemaCode(option, `${schemaName}.union.${index}`))
        .join(", ")}])`;
    } else if (schema instanceof z.ZodString) {
      return "z.string()";
    } else if (schema instanceof z.ZodNumber) {
      if (schema.format === "safeint") return "z.int()";
      return "z.number()";
    } else if (schema instanceof z.ZodBoolean) {
      return "z.boolean()";
    } else if (schema instanceof z.ZodNull) {
      return "z.null()";
    } else if (schema instanceof z.ZodNever) {
      return "z.never()";
    } else if (schema instanceof z.ZodEnum) {
      const values = schema.options;
      if (values.length === 1) {
        return `z.literal(${JSON.stringify(values[0])})`;
      }
      return `z.enum([${values.map((value) => JSON.stringify(value)).join(", ")}])`;
    } else if (schema instanceof z.ZodLiteral) {
      const [value] = schema.values;

      return `z.literal(${JSON.stringify(value)})`;
    } else if (schema instanceof z.ZodNullable) {
      return `${this.generateSchemaCode(schema.unwrap(), schemaName)}.nullable()`;
    } else if (schema instanceof z.ZodOptional) {
      return `${this.generateSchemaCode(schema.unwrap(), schemaName)}.optional()`;
    } else if (schema instanceof z.ZodLazy) {
      const referencedName = this.nameBySchema.get(schema);
      if (referencedName) {
        if (this.generatedSchemas.has(referencedName) && !this.currentlyGenerating.has(referencedName)) {
          if (references === "lazy") return `z.lazy(() => ${this.schemaConstName(referencedName)})`;
          return this.schemaConstName(referencedName);
        }

        // Circular or forward reference: defer resolution so the emitted module
        // evaluates in declaration order instead of hitting a temporal dead zone.
        return `z.lazy((): z.ZodType<unknown> => ${this.schemaConstName(referencedName)})`;
      }
      return `z.lazy(() => ${this.generateSchemaCode(schema.unwrap(), schemaName)})`;
    }
    return "z.unknown()";
  }

  getReferencingSchemaNames(schema: z.ZodType): string[] {
    const extractSchemaNames = (schema: z.core.$ZodType): string[] => {
      const result: string[] = [];
      if (schema instanceof z.ZodObject) {
        const objectSchema: z.ZodObject<z.core.$ZodShape> = schema;
        const propertySchemas = Object.values(objectSchema.shape);

        const { catchall } = objectSchema.def;
        if (!catchall) return propertySchemas.flatMap(extractSchemaNames);

        return [...propertySchemas, catchall].flatMap(extractSchemaNames);
      } else if (schema instanceof z.ZodRecord) {
        return extractSchemaNames(schema.valueType);
      } else if (schema instanceof z.ZodArray) {
        return extractSchemaNames(schema.element);
      } else if (schema instanceof z.ZodIntersection) {
        return [...extractSchemaNames(schema.def.left), ...extractSchemaNames(schema.def.right)];
      } else if (schema instanceof z.ZodUnion) {
        return schema.options.flatMap(extractSchemaNames);
      } else if (schema instanceof z.ZodNullable) {
        return extractSchemaNames(schema.unwrap());
      } else if (schema instanceof z.ZodOptional) {
        return extractSchemaNames(schema.unwrap());
      } else if (schema instanceof z.ZodLazy) {
        const referencedName = this.nameBySchema.get(schema);
        if (referencedName) {
          return [referencedName];
        }
        return extractSchemaNames(schema.unwrap());
      }
      return result;
    };

    if (schema instanceof z.ZodLazy) {
      return extractSchemaNames(schema.unwrap());
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

  private generateObjectCode(schema: z.ZodObject<z.core.$ZodShape>, schemaName: string): string {
    const properties = Object.entries(schema.shape)
      .map(([key, value]) => `${formatObjectKey(key)}: ${this.generateSchemaCode(value, `${schemaName}.${key}`)}`)
      .join(",\n");
    const shapeCode = properties ? `{\n${indent(properties)}\n}` : "{}";

    const { catchall } = schema.def;
    if (!catchall) return `z.object(${shapeCode})`;
    if (catchall instanceof z.ZodNever) return `z.strictObject(${shapeCode})`;
    if (catchall instanceof z.ZodUnknown) return `z.looseObject(${shapeCode})`;

    return `z.object(${shapeCode}).catchall(${this.generateSchemaCode(catchall, `${schemaName}.catchall`, "lazy")})`;
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
      .map((name) => {
        if (this.currentlyGenerating.has(name)) {
          return "";
        }
        this.currentlyGenerating.add(name);

        const schema = this.schemas[name];
        let schemaCode: string;
        if (schema instanceof z.ZodLazy) {
          schemaCode = this.generateSchemaCode(schema.unwrap(), name);
        } else {
          schemaCode = this.generateSchemaCode(schema, name);
        }
        this.currentlyGenerating.delete(name);
        this.generatedSchemas.add(name);
        return `export const ${this.schemaConstName(name)} = ${schemaCode};`;
      })
      .filter(Boolean)
      .join("\n\n");
    return imports + schemaDefinitions;
  }
}

export const codegen = (spec: OpenAPISpec, prefix = ""): string => {
  const converter = new OpenAPIToZodConverter(spec);
  const zodSchemas = converter.convert();
  const codeGenerator = new ZodSchemaCodeGenerator(zodSchemas, prefix);
  return codeGenerator.generateCode();
};
