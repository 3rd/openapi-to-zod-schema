import fs from "fs";
import { parse } from "yaml";
import { codegen } from "./codegen.ts";
import {
  isObjectSchema,
  type OpenAPISchema,
  type OpenAPISchemaArray,
  type OpenAPISchemaBase,
  type OpenAPISchemaObject,
  type OpenAPISchemaRef,
  type OpenAPISchemaString,
  type OpenAPISpec,
} from "./converter.ts";

const fetchSpec = async (url: string): Promise<string> => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Failed to fetch "${url}": HTTP ${response.status}`);

  return response.text();
};

const UNSUPPORTED_FORMAT_MESSAGE = "Unsupported file format. Please provide a YAML or JSON file.";
const COMPONENTS_POINTER = "#/components";
const SCHEMAS_POINTER = `${COMPONENTS_POINTER}/schemas`;

const isRecord = (value: unknown): value is Record<string, unknown> => {
  return typeof value === "object" && value !== null && !Array.isArray(value);
};

const isAbsent = (value: unknown) => value === undefined || value === null;

const describeJsonType = (value: unknown) => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
};

const appendPointerToken = (pointer: string, token: number | string) => {
  // "~" must be escaped before "/": the reverse order would escape the "~" of each "~1" again.
  const escapedToken = String(token).replace(/~/g, "~0").replace(/\//g, "~1");

  return `${pointer}/${escapedToken}`;
};

const createShapeError = (pointer: string, expectedShape: string, value: unknown) => {
  return new Error(
    `Invalid OpenAPI document at ${pointer}: expected ${expectedShape}, received ${describeJsonType(value)}.`
  );
};

const warnIgnoredKeyword = (pointer: string, expectedShape: string, value: unknown) => {
  console.warn(`Warning: Ignoring ${pointer}: expected ${expectedShape}, received ${describeJsonType(value)}`);
};

// An empty YAML value parses as null. A component schema or property left empty that way counts as absent;
// rejecting it would fail documents the converter can still convert.
const toOptionalSchema = (value: unknown, pointer: string) => {
  if (value === null) return undefined;

  return toSchema(value, pointer);
};

const toSchemasByName = (record: Record<string, unknown>, pointer: string) => {
  return Object.fromEntries(
    Object.entries(record).map(([name, schema]) => [name, toOptionalSchema(schema, appendPointerToken(pointer, name))])
  );
};

const toSchemas = (value: unknown, pointer: string) => {
  if (!Array.isArray(value)) throw createShapeError(pointer, "an array", value);

  return value.map((member: unknown, index) => toSchema(member, appendPointerToken(pointer, index)));
};

const toRequiredNames = (value: unknown, pointer: string) => {
  if (!Array.isArray(value)) throw createShapeError(pointer, "an array", value);

  return value.map((member: unknown, index) => {
    if (typeof member !== "string") throw createShapeError(appendPointerToken(pointer, index), "a string", member);

    return member;
  });
};

const toObjectSchema = (base: OpenAPISchemaBase, keywords: Record<string, unknown>, pointer: string) => {
  const { properties, required, additionalProperties, ...metadata } = keywords;
  const { type, ...constraints } = base;
  const schema: OpenAPISchemaObject = { ...metadata, ...constraints };

  if (type === "object") {
    schema.type = type;
  }

  if (!isAbsent(properties)) {
    const propertiesPointer = appendPointerToken(pointer, "properties");

    if (!isRecord(properties)) throw createShapeError(propertiesPointer, "an object", properties);

    schema.properties = toSchemasByName(properties, propertiesPointer);
  }

  if (!isAbsent(required)) {
    schema.required = toRequiredNames(required, appendPointerToken(pointer, "required"));
  }

  if (typeof additionalProperties === "boolean") {
    schema.additionalProperties = additionalProperties;
  } else if (!isAbsent(additionalProperties)) {
    const additionalPropertiesPointer = appendPointerToken(pointer, "additionalProperties");

    if (!isRecord(additionalProperties)) {
      throw createShapeError(additionalPropertiesPointer, "a schema object or a boolean", additionalProperties);
    }

    schema.additionalProperties = toSchema(additionalProperties, additionalPropertiesPointer);
  }

  return schema;
};

const toArraySchema = (base: OpenAPISchemaBase, keywords: Record<string, unknown>, pointer: string) => {
  const { items, ...metadata } = keywords;
  const schema: OpenAPISchemaArray = { ...metadata, ...base, type: "array" };

  if (!isAbsent(items)) {
    schema.items = toSchema(items, appendPointerToken(pointer, "items"));
  }

  return schema;
};

const toStringSchema = (base: OpenAPISchemaBase, keywords: Record<string, unknown>, pointer: string) => {
  const { minLength, maxLength, format, ...metadata } = keywords;
  const schema: OpenAPISchemaString = { ...metadata, ...base, type: "string" };

  for (const [keyword, bound] of [
    ["minLength", minLength],
    ["maxLength", maxLength],
  ] as const) {
    if (bound === undefined) continue;

    const isValidBound = typeof bound === "number" && Number.isInteger(bound) && bound >= 0;
    if (!isValidBound) {
      warnIgnoredKeyword(appendPointerToken(pointer, keyword), "a nonnegative integer", bound);
      continue;
    }

    schema[keyword] = bound;
  }

  if (typeof format === "string") {
    schema.format = format;
  } else if (format !== undefined) {
    warnIgnoredKeyword(appendPointerToken(pointer, "format"), "a string", format);
  }

  return schema;
};

const toSchema = (value: unknown, pointer: string): OpenAPISchema => {
  if (!isRecord(value)) throw createShapeError(pointer, "a schema object", value);

  const ref = value.$ref;
  if (ref !== undefined) {
    if (typeof ref !== "string") throw createShapeError(appendPointerToken(pointer, "$ref"), "a string", ref);

    const { nullable: nullableKeyword, ...siblings } = value;
    const reference: OpenAPISchemaRef = { ...siblings, $ref: ref };

    if (typeof nullableKeyword === "boolean") {
      reference.nullable = nullableKeyword;
    } else if (nullableKeyword !== undefined) {
      warnIgnoredKeyword(appendPointerToken(pointer, "nullable"), "a boolean", nullableKeyword);
    }

    return reference;
  }

  const { type, nullable, enum: enumValues, allOf, anyOf, oneOf, ...keywords } = value;
  const base: OpenAPISchemaBase = {};

  if (typeof type === "string") {
    base.type = type;
  } else if (type !== undefined) {
    warnIgnoredKeyword(appendPointerToken(pointer, "type"), "a string", type);
  }

  if (typeof nullable === "boolean") {
    base.nullable = nullable;
  } else if (nullable !== undefined) {
    warnIgnoredKeyword(appendPointerToken(pointer, "nullable"), "a boolean", nullable);
  }

  if (Array.isArray(enumValues)) {
    base.enum = enumValues;
  } else if (enumValues !== undefined) {
    warnIgnoredKeyword(appendPointerToken(pointer, "enum"), "an array", enumValues);
  }

  if (allOf !== undefined) {
    base.allOf = toSchemas(allOf, appendPointerToken(pointer, "allOf"));
  }

  if (anyOf !== undefined) {
    base.anyOf = toSchemas(anyOf, appendPointerToken(pointer, "anyOf"));
  }

  if (oneOf !== undefined) {
    base.oneOf = toSchemas(oneOf, appendPointerToken(pointer, "oneOf"));
  }

  if (base.type === "array") return toArraySchema(base, keywords, pointer);
  if (base.type === "string") return toStringSchema(base, keywords, pointer);

  // A schema without a usable `type` is converted as an object only because of its `properties`, so two kinds of
  // schema lose that key here. An empty `properties` value counts as absent. A schema whose `type` was ignored must
  // stay unconstrained: as an object it would not be nullable and would reject values the ignored type allows, such
  // as null for `type: [object, "null"]`.
  const hasIgnoredType = type !== undefined && base.type === undefined;
  const hasEmptyProperties = base.type === undefined && keywords.properties === null;
  const hasUnusableProperties = hasIgnoredType || hasEmptyProperties;
  if (hasUnusableProperties) {
    const { properties, ...otherKeywords } = keywords;

    return { ...otherKeywords, ...base };
  }

  const schema: OpenAPISchema = { ...keywords, ...base };
  if (isObjectSchema(schema)) return toObjectSchema(base, keywords, pointer);

  return schema;
};

const toSpec = (document: unknown): OpenAPISpec => {
  if (!isRecord(document)) throw new Error(UNSUPPORTED_FORMAT_MESSAGE);

  const { components } = document;
  if (components === undefined) return document;
  if (!isRecord(components)) throw createShapeError(COMPONENTS_POINTER, "an object", components);

  const { schemas } = components;
  if (schemas === undefined) return { ...document, components };
  if (!isRecord(schemas)) throw createShapeError(SCHEMAS_POINTER, "an object", schemas);

  return { ...document, components: { ...components, schemas: toSchemasByName(schemas, SCHEMAS_POINTER) } };
};

const parseJsonOrYaml = (content: string): unknown => {
  try {
    return JSON.parse(content);
  } catch {
    try {
      return parse(content);
    } catch {
      throw new Error(UNSUPPORTED_FORMAT_MESSAGE);
    }
  }
};

export const parseSpecContent = (content: string) => toSpec(parseJsonOrYaml(content));

const readSpec = async (input: string) => {
  const isRemote = input.startsWith("http://") || input.startsWith("https://");
  const content = isRemote ? await fetchSpec(input) : fs.readFileSync(input, "utf8");

  if (input.endsWith(".yaml") || input.endsWith(".yml")) return toSpec(parse(content));
  if (input.endsWith(".json")) return toSpec(JSON.parse(content));

  return parseSpecContent(content);
};

export const main = async () => {
  const args = process.argv.slice(2);
  const inputFile = args[0];
  const outputFile = args.includes("-o") ? args[args.indexOf("-o") + 1] : null;
  const prefix = args.includes("--prefix") ? args[args.indexOf("--prefix") + 1] : "";

  if (!inputFile) {
    console.error("Please provide an input file or URL.");
    process.exit(1);
  }

  try {
    for (const option of ["-o", "--prefix"]) {
      const optionIndex = args.indexOf(option);
      if (optionIndex < 0) continue;

      const value = args[optionIndex + 1];
      const hasMissingValue =
        value === undefined || value === "-o" || value === "--prefix" || (option === "-o" && value === "");
      if (hasMissingValue) {
        throw new Error(`Please provide a value for ${option}.`);
      }
    }

    const spec = await readSpec(inputFile);
    const code = codegen(spec, prefix);

    if (outputFile) {
      fs.writeFileSync(outputFile, code);
      console.log(`Zod schema generated and saved to ${outputFile}`);
    } else {
      console.log(code);
    }
  } catch (error) {
    console.error("Error:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
};
