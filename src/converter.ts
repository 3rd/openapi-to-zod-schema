import { z } from "zod";

type OpenAPIEnumValue = boolean | number | string | null;

interface OpenAPISchemaBase {
  type?: string;
  nullable?: boolean;
  enum?: unknown[];
  allOf?: OpenAPISchema[];
  anyOf?: OpenAPISchema[];
  oneOf?: OpenAPISchema[];
}

interface OpenAPISchemaObject extends OpenAPISchemaBase {
  type?: "object";
  properties?: Record<string, OpenAPISchema | undefined>;
  required?: string[];
  additionalProperties?: OpenAPISchema | boolean;
}

interface OpenAPISchemaArray extends OpenAPISchemaBase {
  type: "array";
  items?: OpenAPISchema | undefined;
}

interface OpenAPISchemaString extends OpenAPISchemaBase {
  type: "string";
  minLength?: number;
  maxLength?: number;
  format?: string;
}

interface OpenAPISchemaAllOf extends OpenAPISchemaBase {
  allOf: OpenAPISchema[];
}

interface OpenAPISchemaOneOf extends OpenAPISchemaBase {
  oneOf: OpenAPISchema[];
}

interface OpenAPISchemaAnyOf extends OpenAPISchemaBase {
  anyOf: OpenAPISchema[];
}

interface OpenAPISchemaRef {
  $ref: string;
  nullable?: boolean;
}

type OpenAPISchemaRequirement = OpenAPISchemaObject & { required: string[] };

type OpenAPISchema =
  | OpenAPISchemaAllOf
  | OpenAPISchemaAnyOf
  | OpenAPISchemaArray
  | OpenAPISchemaBase
  | OpenAPISchemaObject
  | OpenAPISchemaOneOf
  | OpenAPISchemaRef
  | OpenAPISchemaString;

interface OpenAPISpec {
  components?: {
    schemas?: Record<string, OpenAPISchema | undefined>;
  };
}

const SCHEMA_REF_PREFIX = "#/components/schemas/";

interface SchemaConversionContext {
  references: "inline" | "lazy";
  seenRefs: ReadonlySet<string>;
}

interface SchemaConstraint {
  schema: z.ZodType;
  admitsOnlyObjects: boolean;
  isBareObjectType: boolean;
}

const matchesEnumType = (value: OpenAPIEnumValue, schema: OpenAPISchemaBase) => {
  if (schema.type === undefined) return true;
  if (value === null) return schema.nullable === true;

  switch (schema.type) {
    case "string":
      return typeof value === "string";
    case "number":
      return typeof value === "number";
    case "integer":
      return typeof value === "number" && Number.isSafeInteger(value);
    case "boolean":
      return typeof value === "boolean";
    case "object":
    case "array":
      return false;
    default:
      return true;
  }
};

const isEnumLiteral = (value: unknown): value is OpenAPIEnumValue => {
  return (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  );
};

const isRefSchema = (schema: OpenAPISchema): schema is OpenAPISchemaRef => "$ref" in schema;
const isAllOfSchema = (schema: OpenAPISchema): schema is OpenAPISchemaAllOf => {
  return "allOf" in schema && Array.isArray(schema.allOf);
};

const isOneOfSchema = (schema: OpenAPISchema): schema is OpenAPISchemaOneOf => {
  return "oneOf" in schema && Array.isArray(schema.oneOf);
};

const isAnyOfSchema = (schema: OpenAPISchema): schema is OpenAPISchemaAnyOf => {
  return "anyOf" in schema && Array.isArray(schema.anyOf);
};

const isEnumSchema = (schema: OpenAPISchema): schema is OpenAPISchemaBase & { enum: unknown[] } =>
  "enum" in schema && Array.isArray(schema.enum);
const isObjectSchema = (schema: OpenAPISchema): schema is OpenAPISchemaObject => {
  const hasDeclaredType = "type" in schema && schema.type !== undefined;
  if (hasDeclaredType) return schema.type === "object";

  return "properties" in schema && schema.properties !== undefined;
};
const isArraySchema = (schema: OpenAPISchema): schema is OpenAPISchemaArray =>
  "type" in schema && schema.type === "array";

const isStringSchema = (schema: OpenAPISchema): schema is OpenAPISchemaString => {
  return "type" in schema && schema.type === "string";
};

const isNumberSchema = (schema: OpenAPISchema) => "type" in schema && schema.type === "number";
const isIntegerSchema = (schema: OpenAPISchema) => "type" in schema && schema.type === "integer";
const isBooleanSchema = (schema: OpenAPISchema): schema is OpenAPISchemaBase =>
  "type" in schema && schema.type === "boolean";

const hasOwnType = (schema: OpenAPISchema) => "type" in schema || isObjectSchema(schema);

const isNullableAsWhole = (schema: OpenAPISchema) => {
  if (schema.nullable !== true) return false;
  if (isRefSchema(schema)) return true;
  return !hasOwnType(schema) && !isEnumSchema(schema);
};

const hasComposition = (schema: OpenAPISchema) =>
  isAllOfSchema(schema) || isAnyOfSchema(schema) || isOneOfSchema(schema);

const hasNonNullableObjectType = (schema: OpenAPISchema) => {
  if (!isObjectSchema(schema)) return false;
  if (isEnumSchema(schema)) return false;
  return schema.nullable !== true;
};

const hasBareObjectType = (schema: OpenAPISchema) => {
  if (isRefSchema(schema)) return false;
  if (!isObjectSchema(schema)) return false;
  if (isEnumSchema(schema)) return false;
  if (schema.nullable === true) return false;
  if (schema.additionalProperties !== undefined) return false;
  if ((schema.required ?? []).length > 0) return false;
  return Object.keys(schema.properties ?? {}).length === 0;
};

const isRequirementSchema = (schema: OpenAPISchema): schema is OpenAPISchemaRequirement => {
  if (isRefSchema(schema)) return false;
  if (isEnumSchema(schema)) return false;
  if (hasComposition(schema)) return false;
  if (!("required" in schema)) return false;

  const hasObjectKeyword =
    schema.type !== undefined || schema.properties !== undefined || schema.additionalProperties !== undefined;
  if (hasObjectKeyword) return false;

  // The CLI checks the shape of `required` only on object schemas. On any other schema it passes the value through
  // unchecked, and a value that is not a list of names cannot be merged into an object's required names.
  const { required } = schema;
  if (!Array.isArray(required)) return false;
  if (required.length === 0) return false;
  return required.every((name) => typeof name === "string");
};

const areRequirementSchemas = (schemas: OpenAPISchema[] | undefined): schemas is OpenAPISchemaRequirement[] => {
  if (!schemas) return false;
  if (schemas.length === 0) return false;
  return schemas.every(isRequirementSchema);
};

// A composition member that only lists required names, such as `{ required: ["id"] }`, constrains the object schema
// that composes it. The names go into that object: `allOf` members add theirs, and an `anyOf` or `oneOf` made only of
// such members yields one variant of the object per member. The member cannot become an object schema of its own, and
// beside other composition members it cannot add a name the object does not declare: either would put an object that
// keeps every key, or a field that keeps its whole value, into the intersection, and Zod rejects or strips an unknown
// key of an intersection only when every member does. Such a member is not folded and converts to `z.unknown()`.
const findRequirementVariants = (schema: OpenAPISchema) => {
  if (isRefSchema(schema)) return undefined;
  if (isEnumSchema(schema)) return undefined;
  if (!isObjectSchema(schema)) return undefined;

  const { allOf = [], anyOf, oneOf, properties = {} } = schema;
  const unions = [anyOf, oneOf].filter((members) => members !== undefined);
  const hasOtherMembers =
    allOf.some((member) => !isRequirementSchema(member)) || unions.some((members) => !areRequirementSchemas(members));

  const declaresName = (name: string) => {
    return Object.prototype.hasOwnProperty.call(properties, name) && properties[name] !== undefined;
  };

  const isFoldable = (member: OpenAPISchemaRequirement) => !hasOtherMembers || member.required.every(declaresName);

  const allOfRequirements = allOf.filter(isRequirementSchema).filter(isFoldable);
  const requirementUnions = unions.filter(areRequirementSchemas).filter((members) => members.every(isFoldable));

  const hasFoldableMembers = allOfRequirements.length > 0 || requirementUnions.length > 0;
  if (!hasFoldableMembers) return undefined;

  const sharedNames = [...(schema.required ?? []), ...allOfRequirements.flatMap((member) => member.required)];
  const requiredAlternatives = requirementUnions.reduce<string[][]>(
    (alternatives, members) => {
      return alternatives.flatMap((names) => members.map((member) => [...names, ...member.required]));
    },
    [sharedNames]
  );

  const isFoldedUnion = (members: OpenAPISchema[] | undefined) => {
    return requirementUnions.some((folded) => folded === members);
  };

  const foldedAllOfMembers = new Set<OpenAPISchema>(allOfRequirements);
  const retainedAllOf = allOf.filter((member) => !foldedAllOfMembers.has(member));
  const retainedAnyOf = isFoldedUnion(anyOf) ? undefined : anyOf;
  const retainedOneOf = isFoldedUnion(oneOf) ? undefined : oneOf;

  return requiredAlternatives.map((required) => {
    return {
      ...schema,
      required,
      allOf: retainedAllOf,
      anyOf: retainedAnyOf,
      oneOf: retainedOneOf,
    };
  });
};

class OpenAPIToZodConverter {
  private spec: OpenAPISpec;
  private zodSchemas = new Map<string, z.ZodType>();
  private warnedMessages = new Set<string>();

  constructor(spec: OpenAPISpec) {
    this.spec = spec;
  }

  private warnOnce(message: string) {
    if (this.warnedMessages.has(message)) return;

    this.warnedMessages.add(message);
    console.warn(message);
  }

  private convertSchema(
    schema: OpenAPISchema,
    context: SchemaConversionContext = { references: "inline", seenRefs: new Set() }
  ): z.ZodType {
    const converted = this.convertConstraints(schema, context);

    // `z.unknown()` already accepts null and must stay recognizable: an intersection leaves out members that are exactly
    // `z.unknown()` and a union of only such members stays `z.unknown()`, which a nullable wrapper would prevent.
    const isNullAdded = isNullableAsWhole(schema) && !(converted instanceof z.ZodUnknown);
    if (isNullAdded) return converted.nullable();

    return converted;
  }

  private convertConstraints(schema: OpenAPISchema, context: SchemaConversionContext) {
    if (isRefSchema(schema)) return this.convertReference(schema.$ref, context);

    const requirementVariants = findRequirementVariants(schema);
    if (requirementVariants) return this.handleUnion(requirementVariants, context);

    const { seenRefs } = context;
    const constraints: SchemaConstraint[] = [];

    const hasOwnConstraint = hasOwnType(schema) || isEnumSchema(schema);
    if (hasOwnConstraint) {
      const converted = this.dispatchSchema(schema);
      const isNullable = hasOwnType(schema) && schema.nullable === true;
      const isNullableType = isNullable && !isEnumSchema(schema);

      constraints.push({
        schema: isNullableType ? converted.nullable() : converted,
        admitsOnlyObjects: hasNonNullableObjectType(schema),
        isBareObjectType: hasBareObjectType(schema),
      });
    }

    if (isAllOfSchema(schema)) {
      for (const member of schema.allOf) {
        constraints.push({
          schema: this.convertSchema(member, context),
          admitsOnlyObjects: this.admitsOnlyObjects(member, seenRefs),
          isBareObjectType: hasBareObjectType(member) && !hasComposition(member),
        });
      }
    }

    if (isAnyOfSchema(schema)) {
      constraints.push({
        schema: this.handleUnion(schema.anyOf, context),
        admitsOnlyObjects: this.allAdmitOnlyObjects(schema.anyOf, seenRefs),
        isBareObjectType: false,
      });
    }

    // oneOf is approximated as a plain union: exclusivity and discriminators are not enforced.
    if (isOneOfSchema(schema)) {
      constraints.push({
        schema: this.handleUnion(schema.oneOf, context),
        admitsOnlyObjects: this.allAdmitOnlyObjects(schema.oneOf, seenRefs),
        isBareObjectType: false,
      });
    }

    // Zod rejects an unknown key of an intersection only when both sides reject it, so a member that rejects no keys
    // switches off the unknown-key rejection of every closed object beside it. Two kinds of such members add no
    // validation and stay out: schemas that accept any value, and a bare `type: object` that another member implies.
    const restrictive = constraints.filter((constraint) => !(constraint.schema instanceof z.ZodUnknown));
    const isObjectTypeImplied = restrictive.some((constraint) => {
      return constraint.admitsOnlyObjects && !constraint.isBareObjectType;
    });
    const members = restrictive.filter((constraint) => !(isObjectTypeImplied && constraint.isBareObjectType));

    const [first, ...rest] = members.map((constraint) => constraint.schema);
    if (!first) return z.unknown();

    return rest.reduce<z.ZodType>((left, right) => z.intersection(left, right), first);
  }

  private admitsOnlyObjects(schema: OpenAPISchema, seenRefs: ReadonlySet<string>): boolean {
    if (isNullableAsWhole(schema)) return false;

    if (isRefSchema(schema)) {
      const name = resolveRefName(schema.$ref);
      if (!name) return false;
      if (seenRefs.has(name)) return false;

      const target = this.findReferencedSchema(name);
      if (!target) return false;

      return this.admitsOnlyObjects(target, new Set([...seenRefs, name]));
    }

    if (isEnumSchema(schema)) return false;
    if (hasNonNullableObjectType(schema)) return true;
    if (schema.allOf?.some((member) => this.admitsOnlyObjects(member, seenRefs))) return true;
    if (this.allAdmitOnlyObjects(schema.anyOf, seenRefs)) return true;
    return this.allAdmitOnlyObjects(schema.oneOf, seenRefs);
  }

  private allAdmitOnlyObjects(schemas: OpenAPISchema[] | undefined, seenRefs: ReadonlySet<string>) {
    if (!schemas) return false;
    if (schemas.length === 0) return false;

    return schemas.every((member) => this.admitsOnlyObjects(member, seenRefs));
  }

  private dispatchSchema(schema: OpenAPISchema) {
    if (isEnumSchema(schema)) return this.convertEnumSchema(schema);
    if (isObjectSchema(schema)) return this.convertObjectSchema(schema);
    if (isArraySchema(schema)) return this.convertArraySchema(schema);
    if (isStringSchema(schema)) return this.convertStringSchema(schema);
    if (isIntegerSchema(schema)) return z.int();
    if (isNumberSchema(schema)) return z.number();
    if (isBooleanSchema(schema)) return z.boolean();
    return z.unknown();
  }

  private convertReference(ref: string, context: SchemaConversionContext) {
    // Nested references stay lazy so recursive values do not expand during schema construction.
    if (context.references === "lazy") return this.handleRef(ref);

    const schemaName = resolveRefName(ref);
    if (!schemaName) return this.handleRef(ref);
    if (context.seenRefs.has(schemaName)) {
      this.warnOnce(
        `Warning: Circular $ref "${ref}" does not descend into a property or item; falling back to z.unknown()`
      );

      return z.unknown();
    }

    const target = this.findReferencedSchema(schemaName);
    if (!target) return this.handleRef(ref);
    if (!this.referencesSchema(target, schemaName)) return this.handleRef(ref);

    const nextSeenRefs = new Set(context.seenRefs);
    nextSeenRefs.add(schemaName);

    return this.convertSchema(target, { references: "inline", seenRefs: nextSeenRefs });
  }

  private referencesSchema(schema: OpenAPISchema, targetName: string) {
    const visitedNames = new Set<string>();

    const visitSchema = (currentSchema: OpenAPISchema): boolean => {
      if (isRefSchema(currentSchema)) {
        const name = resolveRefName(currentSchema.$ref);
        if (!name) return false;
        if (name === targetName) return true;
        if (visitedNames.has(name)) return false;

        const target = this.findReferencedSchema(name);
        if (!target) return false;

        visitedNames.add(name);

        return visitSchema(target);
      }

      const members = [...(currentSchema.allOf ?? []), ...(currentSchema.anyOf ?? []), ...(currentSchema.oneOf ?? [])];

      return members.some(visitSchema);
    };

    return visitSchema(schema);
  }

  private convertEnumSchema(schema: OpenAPISchemaBase & { enum: unknown[] }) {
    const values = schema.enum;
    if (values.length === 0) {
      this.warnOnce("Warning: Empty enum encountered; falling back to z.unknown()");

      return z.unknown();
    }

    if (!values.every(isEnumLiteral)) {
      this.warnOnce("Warning: Unsupported enum member; falling back to z.unknown()");

      return z.unknown();
    }

    const permittedValues = values.filter((value) => matchesEnumType(value, schema));
    if (permittedValues.length < values.length) {
      this.warnOnce("Warning: Enum members do not match the declared type; ignoring incompatible values");
    }

    const valuesSchema = this.convertEnumValues(permittedValues);

    const isNullAdded = schema.nullable === true && !permittedValues.includes(null);
    if (isNullAdded) return valuesSchema.nullable();

    return valuesSchema;
  }

  private convertEnumValues(values: OpenAPIEnumValue[]) {
    if (values.length === 0) return z.never();
    if (values.length === 1) return z.literal(values[0]);

    if (values.every((value): value is string => typeof value === "string")) {
      const [firstValue, ...remainingValues] = values;

      return z.enum([firstValue, ...remainingValues]);
    }

    const [first, second, ...rest] = values.map((value) => z.literal(value));

    return z.union([first, second, ...rest]);
  }

  private handleUnion(schemas: OpenAPISchema[], context: SchemaConversionContext) {
    if (schemas.length === 0) {
      this.warnOnce("Warning: Empty oneOf/anyOf encountered; falling back to z.unknown()");
      return z.unknown();
    }
    const convertedSchemas = schemas.map((member) => this.convertSchema(member, context));
    if (convertedSchemas.every((member) => member instanceof z.ZodUnknown)) return z.unknown();

    if (convertedSchemas.length === 1) {
      return convertedSchemas[0];
    }
    const [first, second, ...rest] = convertedSchemas;
    return z.union([first, second, ...rest]);
  }

  private handleRef(ref: string) {
    const schemaName = resolveRefName(ref);
    if (!schemaName) {
      this.warnOnce(`Warning: Unsupported $ref "${ref}"; only ${SCHEMA_REF_PREFIX}<Name> is supported`);
      return z.unknown();
    }
    const existingSchema = this.zodSchemas.get(schemaName);
    if (existingSchema) return existingSchema;

    const refSchema = this.findReferencedSchema(schemaName);
    if (!refSchema) {
      this.warnOnce(`Warning: Referenced schema "${schemaName}" not found in spec`);

      return z.unknown();
    }

    const converted = z.lazy(() => {
      return this.convertSchema(refSchema, { references: "inline", seenRefs: new Set([schemaName]) });
    });
    this.zodSchemas.set(schemaName, converted);

    return converted;
  }

  private findReferencedSchema(schemaName: string) {
    const schemas = this.spec.components?.schemas;
    if (!schemas || !Object.prototype.hasOwnProperty.call(schemas, schemaName)) return undefined;

    return schemas[schemaName];
  }

  private convertObjectSchema(schema: OpenAPISchemaObject) {
    const fields: [string, z.ZodType][] = [];
    const requiredFields = new Set(schema.required ?? []);
    const properties = schema.properties ?? {};
    const { additionalProperties } = schema;

    for (const [key, value] of Object.entries(properties)) {
      if (value) {
        const fieldSchema = this.convertSchema(value, { references: "lazy", seenRefs: new Set() });

        if (requiredFields.has(key)) {
          fields.push([key, fieldSchema]);
        } else {
          fields.push([key, fieldSchema.optional()]);
        }
      }
    }

    for (const key of requiredFields) {
      if (Object.prototype.hasOwnProperty.call(properties, key) && properties[key]) continue;

      if (additionalProperties === false) {
        this.warnOnce(
          `Warning: Required property "${key}" is not declared by an object that forbids additional properties; ignoring the requirement`
        );
        continue;
      }

      const propertySchema = typeof additionalProperties === "object" ? additionalProperties : {};
      fields.push([key, this.convertSchema(propertySchema, { references: "lazy", seenRefs: new Set() })]);
    }

    const shape = Object.fromEntries(fields);
    const hasDeclaredProperties = Object.keys(shape).length > 0;

    if (additionalProperties === false) return z.strictObject(shape);

    if (typeof additionalProperties === "object") {
      const valueSchema = this.convertSchema(additionalProperties, { references: "lazy", seenRefs: new Set() });
      if (hasDeclaredProperties) return z.object(shape).catchall(valueSchema);

      return z.record(z.string(), valueSchema);
    }

    if (additionalProperties === true || Object.keys(properties).length === 0) return z.looseObject(shape);

    return z.object(shape);
  }

  private convertStringSchema(schema: OpenAPISchemaString) {
    let converted = z.string();

    if (schema.minLength !== undefined) {
      converted = converted.min(schema.minLength);
    }

    if (schema.maxLength !== undefined) {
      converted = converted.max(schema.maxLength);
    }

    if (schema.format === "date") {
      converted = converted.check(z.iso.date());
    }

    return converted;
  }

  private convertArraySchema(schema: OpenAPISchemaArray) {
    const itemSchema = schema.items
      ? this.convertSchema(schema.items, { references: "lazy", seenRefs: new Set() })
      : z.unknown();
    return z.array(itemSchema);
  }

  public convert(): Record<string, z.ZodType> {
    const schemas = this.spec.components?.schemas ?? {};
    for (const [name, schema] of Object.entries(schemas)) {
      if (schema) {
        this.zodSchemas.set(
          name,
          z.lazy(() => this.convertSchema(schema, { references: "inline", seenRefs: new Set([name]) }))
        );
      }
    }

    return Object.fromEntries(this.zodSchemas);
  }
}

const resolveRefName = (ref: string): string | null => {
  if (!ref.startsWith(SCHEMA_REF_PREFIX)) return null;
  const name = ref.slice(SCHEMA_REF_PREFIX.length);
  if (!name || name.includes("/")) return null;
  return name;
};

interface ConvertedSchemas {
  map: Record<string, z.ZodType>;
  items: { name: string; schema: z.ZodType }[];
}

export const convertOpenAPISpecToZodSchemas = (spec: OpenAPISpec): ConvertedSchemas => {
  const converter = new OpenAPIToZodConverter(spec);
  const map = converter.convert();
  return {
    map,
    items: Object.entries(map).map(([name, schema]) => ({ name, schema })),
  };
};

export {
  type OpenAPISchema,
  type OpenAPISchemaArray,
  type OpenAPISchemaBase,
  type OpenAPISchemaObject,
  type OpenAPISchemaRef,
  type OpenAPISchemaString,
  type OpenAPISpec,
  isObjectSchema,
  OpenAPIToZodConverter,
};
